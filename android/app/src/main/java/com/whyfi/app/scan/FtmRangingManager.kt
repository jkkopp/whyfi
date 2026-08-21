package com.whyfi.app.scan

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.ScanResult
import android.net.wifi.rtt.RangingRequest
import android.net.wifi.rtt.RangingResult
import android.net.wifi.rtt.RangingResultCallback
import android.net.wifi.rtt.WifiRttManager
import com.whyfi.app.data.remote.FtmObservationDto
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Wraps Android's Wi-Fi RTT/FTM ranging API for a single on-demand
 * measurement against one 802.11mc-responder AP (see
 * WiFiObservation.is80211mcResponder, already captured by ScanResultMapper
 * but otherwise unused until now). Manual, single-target only — this is not
 * a continuous ranging session and doesn't hook into the regular
 * WIFI/CELLULAR/BLE/GNSS scan pass. See ap-localization-design.md's V3.
 *
 * Same shape as ble/UwbLocateManager.kt: hardware-capability-checked, plain
 * class, no ranging-session state kept between calls.
 */
class FtmRangingManager(private val context: Context) {

    private val rttManager: WifiRttManager? =
        context.applicationContext.getSystemService(Context.WIFI_RTT_RANGING_SERVICE) as? WifiRttManager

    /** Hardware + OS capability only — doesn't mean a specific AP will
     * successfully range (that also needs the AP itself to be an
     * 802.11mc responder, checked separately via
     * ScanResult.is80211mcResponder / WiFiObservation.is80211mcResponder). */
    fun isAvailable(): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_RTT) &&
            rttManager?.isAvailable == true

    /** Ranges once against [scanResult] (the AP's own last-seen ScanResult —
     * required by RangingRequest.Builder.addAccessPoint, a bare BSSID string
     * isn't enough). Always resolves, never throws: a hardware/API failure
     * or a non-responder AP comes back as `success = false` with a
     * best-effort [FtmObservationDto.status], not an exception. */
    @SuppressLint("MissingPermission")
    suspend fun range(scanResult: ScanResult): FtmObservationDto {
        val manager = rttManager
        if (manager == null || !isAvailable()) {
            return FtmObservationDto(bssid = scanResult.BSSID ?: "", success = false, status = "unavailable")
        }

        val request = RangingRequest.Builder().addAccessPoint(scanResult).build()
        return suspendCancellableCoroutine { continuation ->
            val executor = Executors.newSingleThreadExecutor()
            manager.startRanging(
                request,
                executor,
                object : RangingResultCallback() {
                    override fun onRangingFailure(code: Int) {
                        executor.shutdown()
                        if (continuation.isActive) {
                            continuation.resume(
                                FtmObservationDto(bssid = scanResult.BSSID ?: "", success = false, status = "failure_$code")
                            )
                        }
                    }

                    override fun onRangingResults(results: MutableList<RangingResult>) {
                        executor.shutdown()
                        val result = results.firstOrNull()
                        if (continuation.isActive) {
                            continuation.resume(result?.let { toDto(scanResult, it) }
                                ?: FtmObservationDto(bssid = scanResult.BSSID ?: "", success = false, status = "no_result"))
                        }
                    }
                },
            )
            continuation.invokeOnCancellation { executor.shutdown() }
        }
    }

    private fun toDto(scanResult: ScanResult, result: RangingResult): FtmObservationDto {
        val success = result.status == RangingResult.STATUS_SUCCESS
        return FtmObservationDto(
            bssid = scanResult.BSSID ?: "",
            success = success,
            distanceMm = if (success) result.distanceMm else null,
            distanceStdDevMm = if (success) result.distanceStdDevMm else null,
            rssi = result.rssi,
            numAttemptedMeasurements = result.numAttemptedMeasurements,
            numSuccessfulMeasurements = result.numSuccessfulMeasurements,
            status = statusLabel(result.status),
        )
    }

    private fun statusLabel(status: Int): String = when (status) {
        RangingResult.STATUS_SUCCESS -> "success"
        RangingResult.STATUS_RESPONDER_DOES_NOT_SUPPORT_IEEE80211MC -> "responder_not_80211mc"
        else -> "fail"
    }
}
