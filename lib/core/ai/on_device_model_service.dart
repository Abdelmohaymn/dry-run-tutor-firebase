import 'dart:async';

import 'package:flutter/widgets.dart';

import 'on_device_model.dart';

/// Holds what the phone can do with Gemini Nano, as a value and a stream.
///
/// Refreshed at launch, when the app comes back to the foreground, and after a
/// download finishes or fails (data-model.md §A5). When the model is
/// `downloadable` and the phone is online it starts the download once per app
/// run, with no prompt (spec US3 scenario 2): the SDK never downloads by itself.
class OnDeviceModelService {
  OnDeviceModelService({
    required OnDeviceModel model,
    required Future<bool> Function() isOnline,
    bool autoDownload = true,
    bool observeLifecycle = true,
  }) : _model = model,
       _isOnline = isOnline,
       _autoDownload = autoDownload,
       _observeLifecycle = observeLifecycle;

  final OnDeviceModel _model;
  final Future<bool> Function() _isOnline;
  final bool _autoDownload;
  final bool _observeLifecycle;

  final StreamController<OnDeviceStatus> _statuses = StreamController<OnDeviceStatus>.broadcast();
  OnDeviceStatus _current = OnDeviceStatus.unavailable;
  StreamSubscription<OnDeviceDownloadEvent>? _downloadSub;
  AppLifecycleListener? _lifecycle;
  bool _downloadRequested = false;

  /// The last status read. `unavailable` until the first [refresh] completes.
  OnDeviceStatus get current => _current;

  Stream<OnDeviceStatus> get statuses => _statuses.stream;

  /// Reads the status once and starts listening for download progress and for
  /// the app returning to the foreground.
  Future<void> start() async {
    _downloadSub ??= _model.downloadEvents().listen((OnDeviceDownloadEvent event) {
      if (event is OnDeviceDownloadCompleted || event is OnDeviceDownloadFailed) {
        unawaited(refresh());
      }
    }, onError: (Object _) {});
    if (_observeLifecycle) {
      _lifecycle ??= AppLifecycleListener(onResume: () => unawaited(refresh()));
    }
    await refresh();
  }

  Future<OnDeviceStatus> refresh() async {
    OnDeviceStatus status = await _read();
    if (_autoDownload && status == OnDeviceStatus.downloadable && !_downloadRequested && await _isOnline()) {
      _downloadRequested = true;
      await _model.download();
      status = await _read();
    }
    _set(status);
    return status;
  }

  Future<OnDeviceStatus> _read() async {
    try {
      return await _model.status();
    } catch (_) {
      return OnDeviceStatus.unavailable;
    }
  }

  void _set(OnDeviceStatus status) {
    if (status == _current) return;
    _current = status;
    _statuses.add(status);
  }

  Future<void> dispose() async {
    await _downloadSub?.cancel();
    _lifecycle?.dispose();
    await _statuses.close();
  }
}
