package app.dryrun

import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.firebase.Firebase
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.ai
import com.google.firebase.ai.ondevice.DownloadStatus
import com.google.firebase.ai.ondevice.FirebaseAIOnDevice
import com.google.firebase.ai.ondevice.OnDeviceModelStatus
import com.google.firebase.ai.type.FirebaseAIOnDeviceNotAvailableException
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.PublicPreviewAPI
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * The on-device half of hybrid inference (feature 010, contracts/on-device-channel.md):
 * Gemini Nano through Firebase AI Logic's `firebase-ai-ondevice`, `ONLY_ON_DEVICE`.
 *
 * It never reaches the cloud — the online path is Dart `firebase_ai`. The offline
 * tutor's prompt is built from the public problem statement only, so nothing here
 * can see ground truth; the response's inference source is still checked and
 * anything that did not run on the device is refused (defence in depth, FR-009).
 *
 * Neither the prompt nor the reply is ever logged.
 */
@OptIn(PublicPreviewAPI::class)
class OnDeviceModelChannel : MethodCallHandler, EventChannel.StreamHandler {
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    private val sink = AtomicReference<EventChannel.EventSink?>(null)
    private val main = Handler(Looper.getMainLooper())
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var downloadJob: Job? = null

    companion object {
        private const val CHANNEL_NAME = "app.dryrun/ondevice"
        private const val EVENT_CHANNEL_NAME = "app.dryrun/ondevice/download"

        /** `firebase-ai-ondevice` needs API 26; the app's minSdk is 26 as well. */
        private const val MIN_SDK = 26

        /** The cloud model id the SDK requires to build a model; never called in ONLY_ON_DEVICE mode. */
        private const val PLACEHOLDER_MODEL = "gemini-placeholder"
    }

    fun attach(binaryMessenger: BinaryMessenger) {
        methods = MethodChannel(binaryMessenger, CHANNEL_NAME).also { it.setMethodCallHandler(this) }
        events = EventChannel(binaryMessenger, EVENT_CHANNEL_NAME).also { it.setStreamHandler(this) }
        if (!scope.coroutineContext[Job]!!.isActive) {
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        }
    }

    fun detach() {
        methods?.setMethodCallHandler(null)
        events?.setStreamHandler(null)
        methods = null
        events = null
        downloadJob?.cancel()
        scope.cancel()
    }

    override fun onMethodCall(call: MethodCall, result: Result) {
        when (call.method) {
            "status" -> status(result)
            "download" -> download(result)
            "generate" -> generate(call, result)
            else -> result.notImplemented()
        }
    }

    // --- EventChannel.StreamHandler -------------------------------------------

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink.set(events)
    }

    override fun onCancel(arguments: Any?) {
        sink.set(null)
    }

    // --- status -----------------------------------------------------------------

    private fun status(result: Result) {
        if (Build.VERSION.SDK_INT < MIN_SDK) {
            result.success("unavailable")
            return
        }
        scope.launch {
            val value = try {
                when (FirebaseAIOnDevice.checkStatus()) {
                    OnDeviceModelStatus.AVAILABLE -> "available"
                    OnDeviceModelStatus.DOWNLOADING -> "downloading"
                    OnDeviceModelStatus.DOWNLOADABLE -> "downloadable"
                    else -> "unavailable"
                }
            } catch (_: Throwable) {
                "unavailable"
            }
            main.post { result.success(value) }
        }
    }

    // --- download ---------------------------------------------------------------

    private fun download(result: Result) {
        // Returns at once; progress goes to the EventChannel. A second call while a
        // download is running does not start another.
        main.post { result.success(null) }
        if (Build.VERSION.SDK_INT < MIN_SDK) return
        if (downloadJob?.isActive == true) return
        downloadJob = scope.launch {
            try {
                if (FirebaseAIOnDevice.checkStatus() != OnDeviceModelStatus.DOWNLOADABLE) return@launch
                FirebaseAIOnDevice.download().collect { status ->
                    when (status) {
                        is DownloadStatus.DownloadStarted -> emit(mapOf("event" to "started"))
                        is DownloadStatus.DownloadInProgress ->
                            emit(mapOf("event" to "progress", "bytes" to status.totalBytesDownloaded))
                        is DownloadStatus.DownloadCompleted -> emit(mapOf("event" to "completed"))
                        is DownloadStatus.DownloadFailed -> emit(mapOf("event" to "failed"))
                        else -> Unit
                    }
                }
            } catch (_: Throwable) {
                emit(mapOf("event" to "failed"))
            }
        }
    }

    private fun emit(event: Map<String, Any>) {
        main.post { sink.get()?.success(event) }
    }

    // --- generate ---------------------------------------------------------------

    private fun generate(call: MethodCall, result: Result) {
        val prompt = call.argument<String>("prompt")
        val maxOutputTokens = call.argument<Int>("maxOutputTokens") ?: 256
        val temperature = (call.argument<Double>("temperature") ?: 0.4).toFloat()
        if (prompt == null) {
            result.error("FAILED", "missing prompt", null)
            return
        }
        scope.launch {
            try {
                if (Build.VERSION.SDK_INT < MIN_SDK || FirebaseAIOnDevice.checkStatus() != OnDeviceModelStatus.AVAILABLE) {
                    fail(result, "NOT_READY")
                    return@launch
                }
                val model = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
                    modelName = PLACEHOLDER_MODEL,
                    onDeviceConfig = OnDeviceConfig(
                        mode = InferenceMode.ONLY_ON_DEVICE,
                        maxOutputTokens = maxOutputTokens,
                        temperature = temperature,
                    ),
                )
                val response = model.generateContent(prompt)
                if (response.inferenceSource != InferenceSource.ON_DEVICE) {
                    fail(result, "FAILED")
                    return@launch
                }
                val text = response.text ?: ""
                main.post { result.success(text) }
            } catch (e: Throwable) {
                fail(result, codeFor(e))
            }
        }
    }

    private fun fail(result: Result, code: String) {
        // The message is the code only: an exception's own text could echo the prompt.
        main.post { result.error(code, code, null) }
    }

    /** Maps an SDK failure onto the contract's closed set of codes. */
    private fun codeFor(e: Throwable): String {
        if (e is FirebaseAIOnDeviceNotAvailableException) return "NOT_READY"
        val text = generateSequence(e) { it.cause }.joinToString(" ") { "${it.javaClass.simpleName} ${it.message ?: ""}" }
        return when {
            text.contains("BACKGROUND_USE_BLOCKED") -> "BACKGROUND"
            text.contains("PER_APP_BATTERY_USE_QUOTA_EXCEEDED") || text.contains("BUSY") -> "BUSY"
            else -> "FAILED"
        }
    }
}
