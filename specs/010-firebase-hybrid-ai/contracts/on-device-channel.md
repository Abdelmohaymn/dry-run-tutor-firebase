# Contract: On-device model channel (`app.dryrun/ondevice`)

Dart `MethodChannel('app.dryrun/ondevice')` ↔ Kotlin
`android/app/src/main/kotlin/app/dryrun/OnDeviceModelChannel.kt`, registered in
`MainActivity.configureFlutterEngine` next to the existing channels
(`TrustedTimeChannel.kt`, `DeviceIdChannel.kt` show the pattern).

Plus one `EventChannel('app.dryrun/ondevice/download')` for download progress.

Kotlin side uses Firebase AI Logic hybrid inference only:
`firebase-ai` + `firebase-ai-ondevice` (research.md R5), `InferenceMode.ONLY_ON_DEVICE`.
It MUST NOT call the cloud: the online path is Dart `firebase_ai`.

## Methods

### `status` → `String`

`"unavailable" | "downloadable" | "downloading" | "available"` — from
`FirebaseAIOnDevice.checkStatus()`. Any exception, or API < 26 → `"unavailable"`.

### `download` → `null`

Starts `FirebaseAIOnDevice.download()` if status is `downloadable`; no-op
otherwise. Returns immediately; progress goes to the EventChannel. Idempotent:
a second call while downloading does not start another.

### `generate` `{prompt: String, maxOutputTokens: int, temperature: double}` → `String`

One non-streaming `generateContent(prompt)` on the on-device model. Returns the
text (may be empty). Errors → `PlatformException` with `code`:

| code | When | Dart maps to |
|---|---|---|
| `NOT_READY` | status ≠ available | treat as unavailable for this turn |
| `BUSY` | `BUSY`, `PER_APP_BATTERY_USE_QUOTA_EXCEEDED` | `failedRetryable`, "offline tutor is busy" |
| `BACKGROUND` | `BACKGROUND_USE_BLOCKED` | `failedRetryable` (silent retry is NOT done) |
| `FAILED` | anything else | `failedRetryable` |

Timeout: Dart side wraps the call in 30 s.

The response's inference source (`ON_DEVICE` / `IN_CLOUD`) MUST be checked;
anything but on-device → `FAILED` (defence in depth for FR-009).

## Event stream `app.dryrun/ondevice/download`

Events: `{"event":"started"}`, `{"event":"progress","bytes":<int>}`,
`{"event":"completed"}`, `{"event":"failed"}`. The Dart service refreshes
`status` on `completed`/`failed`.

## Dart interface (`lib/core/ai/on_device_model.dart`)

```dart
abstract interface class OnDeviceModel {
  Future<OnDeviceStatus> status();
  Future<void> download();
  Stream<OnDeviceDownloadEvent> downloadEvents();
  Future<String> generate(String prompt, {int maxOutputTokens = 256, double temperature = 0.4});
}
```

`ChannelOnDeviceModel` implements it; `FakeOnDeviceModel` in `test/fakes/`.
Constructor-injected (Locked Stack: `sl<T>()` only at the composition root).

## Logging

Neither side logs `prompt` or the reply text (release or debug).
