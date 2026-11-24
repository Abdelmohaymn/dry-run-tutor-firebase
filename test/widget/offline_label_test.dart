// FR-010: an exchange the on-device tutor answered is labelled, so the learner
// always knows which tutor they are talking to; online rows keep their labels.
import 'package:dry_run/core/l10n/generated/app_localizations.dart';
import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/core/theme/app_theme.dart';
import 'package:dry_run/features/chat/domain/message.dart';
import 'package:dry_run/features/chat/presentation/widgets/message_list.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Message _row(int seq, TurnRole role, String text, {MessageOrigin origin = MessageOrigin.online}) => Message(
  id: 'm$seq',
  seq: seq,
  role: role,
  text: text,
  kind: MessageKind.turn,
  delivery: Delivery.sent,
  origin: origin,
);

void main() {
  testWidgets('offline rows carry the offline labels; online rows do not', (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: appTheme,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: MessageList(
            messages: <Message>[
              _row(0, TurnRole.user, 'an online idea'),
              _row(1, TurnRole.tutor, 'an online reply'),
              _row(2, TurnRole.user, 'an offline idea', origin: MessageOrigin.offline),
              _row(3, TurnRole.tutor, 'an offline reply', origin: MessageOrigin.offline),
            ],
            hintCount: 3,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final AppLocalizations l10n = AppLocalizations.of(tester.element(find.byType(MessageList)))!;

    expect(find.text(l10n.offlineTutorLabel), findsOneWidget, reason: 'one offline tutor reply, one caption');
    expect(find.text('${l10n.messageListYouLabel} · ${l10n.offlineTutorYouLabel}'), findsOneWidget);
    expect(find.text(l10n.messageListTutorLabel), findsOneWidget, reason: 'the online reply keeps "Tutor"');
    expect(find.text(l10n.messageListYouLabel), findsOneWidget, reason: 'the online turn keeps "You"');
  });
}
