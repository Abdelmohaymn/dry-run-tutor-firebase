import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/ai/debug_model_gateway.dart';
import '../../../core/ai/on_device_model.dart';
import '../../../core/ai/on_device_model_service.dart';
import '../../../core/di/service_locator.dart';
import '../../../core/l10n/generated/app_localizations.dart';
import '../../../core/router/app_route.dart';
import '../../../core/theme/app_theme.dart';

/// `/settings` — the reminder, the wipe, and a read-only line about the offline
/// tutor (the provider-key row is gone on this entry, FR-015). The prototype
/// draws no settings screen at all (spec.md's "screens the prototype does not
/// draw"); built in the same tokens and one-thing-per-row discipline as the rest.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, this.onDeviceService});

  /// Injected by tests; the app reads the registered one.
  final OnDeviceModelService? onDeviceService;

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.settingsScreenTitle),
      ),
      body: SafeArea(
        child: ListView(
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.notifications_outlined),
              title: Text(l10n.settingsReminderLabel, style: context.appTypography.sansBody),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push(AppRoute.settingsReminder.path),
            ),
            _OfflineTutorTile(service: onDeviceService ?? sl<OnDeviceModelService>()),
            if (kDebugMode)
              ValueListenableBuilder<bool>(
                valueListenable: DebugModelGateway.simulateRateLimit,
                builder: (BuildContext context, bool on, _) => SwitchListTile(
                  secondary: const Icon(Icons.bug_report_outlined),
                  title: Text(l10n.settingsSimulateRateLimitLabel, style: context.appTypography.sansBody),
                  value: on,
                  onChanged: (bool value) => DebugModelGateway.simulateRateLimit.value = value,
                ),
              ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: Text(l10n.settingsWipeLabel, style: context.appTypography.sansBody),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push(AppRoute.settingsWipe.path),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Offline tutor: Ready / Downloading / Not supported on this phone" (T066).
class _OfflineTutorTile extends StatelessWidget {
  const _OfflineTutorTile({required this.service});

  final OnDeviceModelService service;

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context)!;
    return StreamBuilder<OnDeviceStatus>(
      stream: service.statuses,
      initialData: service.current,
      builder: (BuildContext context, AsyncSnapshot<OnDeviceStatus> snapshot) {
        final String status = switch (snapshot.data ?? OnDeviceStatus.unavailable) {
          OnDeviceStatus.available => l10n.settingsOfflineTutorReady,
          OnDeviceStatus.downloading => l10n.settingsOfflineTutorDownloading,
          OnDeviceStatus.downloadable => l10n.settingsOfflineTutorWillDownload,
          OnDeviceStatus.unavailable => l10n.settingsOfflineTutorNotSupported,
        };
        return ListTile(
          leading: const Icon(Icons.cloud_off_outlined),
          title: Text(l10n.settingsOfflineTutorLabel, style: context.appTypography.sansBody),
          subtitle: Text(status, style: context.appTypography.sansCaption),
        );
      },
    );
  }
}
