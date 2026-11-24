import 'dart:async';

import 'package:flutter/services.dart';

/// What the phone can do with Gemini Nano right now (data-model.md §A5).
enum OnDeviceStatus { unavailable, downloadable, downloading, available }

/// Progress of the one-time model download (contracts/on-device-channel.md).
sealed class OnDeviceDownloadEvent {
  const OnDeviceDownloadEvent();
}

final class OnDeviceDownloadStarted extends OnDeviceDownloadEvent {
  const OnDeviceDownloadStarted();
}

final class OnDeviceDownloadProgress extends OnDeviceDownloadEvent {
  const OnDeviceDownloadProgress(this.bytes);

  final int bytes;
}

final class OnDeviceDownloadCompleted extends OnDeviceDownloadEvent {
  const OnDeviceDownloadCompleted();
}

final class OnDeviceDownloadFailed extends OnDeviceDownloadEvent {
  const OnDeviceDownloadFailed();
}

/// Why `generate` produced no text — the closed set of the channel's error codes.
enum OnDeviceErrorCode {
  /// The model is not (or no longer) available: treat as unavailable for this turn.
  notReady,

  /// The system is rationing the model (`BUSY`, per-app battery quota).
  busy,

  /// Gemini Nano only runs while the app is in the foreground.
  background,

  /// Anything else, including an answer that did not run on the device.
  failed,
}

class OnDeviceException implements Exception {
  const OnDeviceException(this.code);

  final OnDeviceErrorCode code;

  /// Never carries the prompt or the reply.
  @override
  String toString() => 'OnDeviceException(${code.name})';
}

/// The on-device model, behind the `app.dryrun/ondevice` channel. Never logs
/// the prompt or the reply (contracts/on-device-channel.md).
abstract interface class OnDeviceModel {
  Future<OnDeviceStatus> status();

  /// Starts the download when the model is `downloadable`; progress arrives on
  /// [downloadEvents]. Idempotent.
  Future<void> download();

  Stream<OnDeviceDownloadEvent> downloadEvents();

  /// One non-streaming generation. Throws [OnDeviceException].
  Future<String> generate(String prompt, {int maxOutputTokens = 256, double temperature = 0.4});
}

class ChannelOnDeviceModel implements OnDeviceModel {
  ChannelOnDeviceModel({MethodChannel? methods, EventChannel? events})
    : _methods = methods ?? const MethodChannel('app.dryrun/ondevice'),
      _events = events ?? const EventChannel('app.dryrun/ondevice/download');

  final MethodChannel _methods;
  final EventChannel _events;

  @override
  Future<OnDeviceStatus> status() async {
    try {
      return switch (await _methods.invokeMethod<String>('status')) {
        'available' => OnDeviceStatus.available,
        'downloading' => OnDeviceStatus.downloading,
        'downloadable' => OnDeviceStatus.downloadable,
        _ => OnDeviceStatus.unavailable,
      };
    } on PlatformException {
      return OnDeviceStatus.unavailable;
    } on MissingPluginException {
      // Not Android (a test host, the web): there is no on-device model.
      return OnDeviceStatus.unavailable;
    }
  }

  @override
  Future<void> download() async {
    try {
      await _methods.invokeMethod<void>('download');
    } on PlatformException {
      // A failed start surfaces as a `failed` event or a later status; nothing to do here.
    } on MissingPluginException {
      // See [status].
    }
  }

  @override
  Stream<OnDeviceDownloadEvent> downloadEvents() => _events.receiveBroadcastStream().map((Object? raw) {
    final Map<Object?, Object?> event = raw! as Map<Object?, Object?>;
    return switch (event['event']) {
      'started' => const OnDeviceDownloadStarted(),
      'progress' => OnDeviceDownloadProgress((event['bytes'] as num?)?.toInt() ?? 0),
      'completed' => const OnDeviceDownloadCompleted(),
      _ => const OnDeviceDownloadFailed(),
    };
  });

  @override
  Future<String> generate(String prompt, {int maxOutputTokens = 256, double temperature = 0.4}) async {
    try {
      final String? text = await _methods.invokeMethod<String>('generate', <String, Object?>{
        'prompt': prompt,
        'maxOutputTokens': maxOutputTokens,
        'temperature': temperature,
      });
      return text ?? '';
    } on PlatformException catch (e) {
      throw OnDeviceException(switch (e.code) {
        'NOT_READY' => OnDeviceErrorCode.notReady,
        'BUSY' => OnDeviceErrorCode.busy,
        'BACKGROUND' => OnDeviceErrorCode.background,
        _ => OnDeviceErrorCode.failed,
      });
    } on MissingPluginException {
      throw const OnDeviceException(OnDeviceErrorCode.notReady);
    }
  }
}
