package com.whyfi.app.scan

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import com.whyfi.app.data.remote.WifiObservationDto
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class WifiScanManager(private val context: Context) {

    private val wifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    val throttle = ScanThrottleController()

    /** Non-null only when WiFi scanning can't proceed — e.g. WiFi turned
     * off directly, or via airplane mode. Checking the radio's actual
     * enabled state (rather than just the airplane-mode flag) avoids a
     * false warning for the common case of airplane mode + WiFi manually
     * re-enabled. */
    fun unavailableReason(): String? = if (!wifiManager.isWifiEnabled) "WiFi is turned off." else null

    /** The platform's own last-scan cache — WifiManager keeps this current
     * regardless of who triggered the most recent scan, so it's what
     * FtmRangingManager reads to find a favorited BSSID's full [ScanResult]
     * (RTT ranging needs the real result object, not just the BSSID
     * string). No caching of our own needed. */
    @SuppressLint("MissingPermission")
    fun lastScanResults(): List<ScanResult> = wifiManager.scanResults

    @SuppressLint("MissingPermission")
    suspend fun scan(): List<WifiObservationDto> = suspendCancellableCoroutine { continuation ->
        val appContext = context.applicationContext
        val filter = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                runCatching { appContext.unregisterReceiver(this) }
                if (continuation.isActive) {
                    continuation.resume(wifiManager.scanResults.map(ScanResultMapper::toDto))
                }
            }
        }
        appContext.registerReceiver(receiver, filter)
        continuation.invokeOnCancellation { runCatching { appContext.unregisterReceiver(receiver) } }

        throttle.recordScanAttempt()
        val started = wifiManager.startScan()
        if (!started) {
            // OS throttled the request — fall back to the last known
            // results rather than hanging until a broadcast that never comes.
            runCatching { appContext.unregisterReceiver(receiver) }
            if (continuation.isActive) {
                continuation.resume(wifiManager.scanResults.map(ScanResultMapper::toDto))
            }
        }
    }
}
