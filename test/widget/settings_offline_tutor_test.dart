// T066: Settings says plainly whether the offline tutor is ready on this phone.
import 'package:dry_run/core/ai/on_device_model.dart';
import 'package:dry_run/core/ai/on_device_model_service.dart';
import 'package:dry_run/core/l10n/generated/app_localizations.dart';
import 'package:dry_run/core/theme/app_theme.dart';
import 'package:dry_run/features/settings/presentation/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes/fake_on_device_model.dart';

Future<AppLocalizations> _pump(WidgetTester tester, OnDeviceStatus status) async {
  final OnDeviceModelService service = OnDeviceModelService(
    model: FakeOnDeviceModel(currentStatus: status),
    isOnline: () async => false,
    observeLifecycle: false,
  );
  await service.start();
  await tester.pumpWidget(
    MaterialApp(
      theme: appTheme,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: SettingsScreen(onDeviceService: service),
    ),
  );
  await tester.pumpAndSettle();
  return AppLocalizations.of(tester.element(find.byType(SettingsScreen)))!;
}

void main() {
  for (final (OnDeviceStatus status, String Function(AppLocalizations) text) in <(OnDeviceStatus, String Function(AppLocalizations))>[
    (OnDeviceStatus.available, (AppLocalizations l) => l.settingsOfflineTutorReady),
    (OnDeviceStatus.downloading, (AppLocalizations l) => l.settingsOfflineTutorDownloading),
    (OnDeviceStatus.unavailable, (AppLocalizations l) => l.settingsOfflineTutorNotSupported),
  ]) {
    testWidgets('shows the offline tutor as ${status.name}', (WidgetTester tester) async {
      final AppLocalizations l10n = await _pump(tester, status);
      expect(find.text(l10n.settingsOfflineTutorLabel), findsOneWidget);
      expect(find.text(text(l10n)), findsOneWidget);
    });
  }

  testWidgets('has no provider-key row on this entry (FR-015)', (WidgetTester tester) async {
    final AppLocalizations l10n = await _pump(tester, OnDeviceStatus.available);
    expect(find.text(l10n.settingsKeyManagementLabel), findsNothing);
  });
}
