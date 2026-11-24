import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/features/chat/data/offline_note.dart';
import 'package:dry_run/features/chat/domain/message.dart';
import 'package:flutter_test/flutter_test.dart';

Message _row(
  int seq,
  TurnRole role,
  String text, {
  MessageOrigin origin = MessageOrigin.online,
  Delivery delivery = Delivery.sent,
}) => Message(
  id: 'm$seq',
  seq: seq,
  role: role,
  text: text,
  kind: MessageKind.turn,
  delivery: delivery,
  origin: origin,
);

void main() {
  test('no offline rows → null', () {
    expect(offlineNote(<Message>[_row(0, TurnRole.user, 'hi'), _row(1, TurnRole.tutor, 'hello')]), isNull);
  });

  test('quotes the learner only, oldest first, joined with " / "', () {
    final String? note = offlineNote(<Message>[
      _row(0, TurnRole.user, 'first idea', origin: MessageOrigin.offline),
      _row(1, TurnRole.tutor, 'TUTOR WORDS', origin: MessageOrigin.offline),
      _row(2, TurnRole.user, 'second idea', origin: MessageOrigin.offline),
      _row(3, TurnRole.tutor, 'MORE TUTOR WORDS', origin: MessageOrigin.offline),
    ]);
    expect(note, 'first idea / second idea');
  });

  test('each quote is trimmed and cut to 200 characters', () {
    final String? note = offlineNote(<Message>[
      _row(0, TurnRole.user, '   ${'a' * 300}   ', origin: MessageOrigin.offline),
    ]);
    expect(note, 'a' * 200);
  });

  test('the whole note is at most 600 characters, and the newest quotes win', () {
    final List<Message> rows = <Message>[
      for (int i = 0; i < 6; i++) _row(i * 2, TurnRole.user, '${'$i' * 200}', origin: MessageOrigin.offline),
    ];
    final String note = offlineNote(rows)!;
    expect(note.length, lessThanOrEqualTo(maxOfflineNoteChars));
    expect(note.endsWith('5' * 200), isTrue, reason: 'the newest quote is kept');
    expect(note.contains('0' * 200), isFalse, reason: 'the oldest is dropped first');
  });

  test('offline rows before the last delivered online learner turn are ignored', () {
    final String? note = offlineNote(<Message>[
      _row(0, TurnRole.user, 'said offline, already forwarded', origin: MessageOrigin.offline),
      _row(1, TurnRole.tutor, 'x', origin: MessageOrigin.offline),
      _row(2, TurnRole.user, 'online turn that went through'),
      _row(3, TurnRole.tutor, 'reply'),
      _row(4, TurnRole.user, 'said offline since', origin: MessageOrigin.offline),
    ]);
    expect(note, 'said offline since');
  });

  test('an online learner turn that has not been delivered does not reset the note', () {
    final String? note = offlineNote(<Message>[
      _row(0, TurnRole.user, 'offline thought', origin: MessageOrigin.offline),
      _row(1, TurnRole.user, 'being sent right now', delivery: Delivery.sending),
    ]);
    expect(note, 'offline thought');
  });
}
