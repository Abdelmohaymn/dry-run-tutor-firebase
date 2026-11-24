import 'package:dry_run/core/ai/on_device_model.dart';
import 'package:dry_run/core/ai/on_device_model_service.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes/fake_on_device_model.dart';

void main() {
  late FakeOnDeviceModel model;
  bool online = true;

  OnDeviceModelService build({bool autoDownload = true}) => OnDeviceModelService(
    model: model,
    isOnline: () async => online,
    autoDownload: autoDownload,
    observeLifecycle: false,
  );

  setUp(() {
    model = FakeOnDeviceModel(currentStatus: OnDeviceStatus.available);
    online = true;
  });

  test('reads the status at start', () async {
    final OnDeviceModelService service = build();
    expect(service.current, OnDeviceStatus.unavailable, reason: 'nothing read yet');
    await service.start();
    expect(service.current, OnDeviceStatus.available);
    await service.dispose();
  });

  test('a phone without Nano stays unavailable and never downloads', () async {
    model.currentStatus = OnDeviceStatus.unavailable;
    final OnDeviceModelService service = build();
    await service.start();
    expect(service.current, OnDeviceStatus.unavailable);
    expect(model.downloads, 0);
    await service.dispose();
  });

  test('downloadable and online → starts the download once, with no prompt', () async {
    model.currentStatus = OnDeviceStatus.downloadable;
    final OnDeviceModelService service = build();
    await service.start();
    await service.refresh();
    await service.refresh();
    expect(model.downloads, 1, reason: 'once per app run');
    await service.dispose();
  });

  test('downloadable but offline → waits', () async {
    model.currentStatus = OnDeviceStatus.downloadable;
    online = false;
    final OnDeviceModelService service = build();
    await service.start();
    expect(model.downloads, 0);
    expect(service.current, OnDeviceStatus.downloadable);
    online = true;
    await service.refresh();
    expect(model.downloads, 1);
    await service.dispose();
  });

  test('a completed download refreshes the status and announces it', () async {
    model.currentStatus = OnDeviceStatus.downloading;
    final OnDeviceModelService service = build();
    await service.start();
    expect(service.current, OnDeviceStatus.downloading);

    final Future<OnDeviceStatus> next = service.statuses.first;
    model.currentStatus = OnDeviceStatus.available;
    model.emit(const OnDeviceDownloadCompleted());
    expect(await next, OnDeviceStatus.available);
    expect(service.current, OnDeviceStatus.available);
    await service.dispose();
  });

  test('autoDownload: false never starts a download', () async {
    model.currentStatus = OnDeviceStatus.downloadable;
    final OnDeviceModelService service = build(autoDownload: false);
    await service.start();
    expect(model.downloads, 0);
    await service.dispose();
  });
}
