import '../../../core/models/wire_enums.dart';
import '../domain/message.dart';

/// Longest quote kept from one offline turn.
const int _maxQuoteChars = 200;

/// Longest note the relay accepts (`offline_note`, ≤ 600).
const int maxOfflineNoteChars = 600;

const String _separator = ' / ';

/// What the learner said to the offline tutor since the last online turn went
/// through (FR-011a, research.md R10): their own words, quoted, oldest first,
/// each cut to 200 characters, the whole note at most 600 — the newest quotes
/// win when it does not fit. No model writes it, so it cannot invent a claim.
///
/// [rows] are the session's rows in conversation order. Offline learner rows
/// *before* the last online learner row that was delivered are not included:
/// that turn already reached the relay with the conversation, so the same words
/// are never sent twice. Returns `null` when there is nothing to say.
String? offlineNote(List<Message> rows) {
  int lastOnlineSent = -1;
  for (final Message m in rows) {
    if (m.role == TurnRole.user && m.origin == MessageOrigin.online && m.delivery == Delivery.sent && m.seq > lastOnlineSent) {
      lastOnlineSent = m.seq;
    }
  }

  final List<String> quotes = <String>[
    for (final Message m in rows)
      if (m.role == TurnRole.user && m.origin == MessageOrigin.offline && m.seq > lastOnlineSent && m.text.trim().isNotEmpty)
        _clip(m.text.trim()),
  ];
  if (quotes.isEmpty) return null;

  // Keep the newest quotes that fit.
  final List<String> kept = <String>[];
  int length = 0;
  for (final String quote in quotes.reversed) {
    final int next = length + quote.length + (kept.isEmpty ? 0 : _separator.length);
    if (next > maxOfflineNoteChars) break;
    kept.insert(0, quote);
    length = next;
  }
  if (kept.isEmpty) {
    // A single quote longer than the note allows cannot happen (200 < 600), but never return empty.
    return quotes.last.substring(0, maxOfflineNoteChars.clamp(0, quotes.last.length));
  }
  return kept.join(_separator);
}

String _clip(String text) => text.length <= _maxQuoteChars ? text : text.substring(0, _maxQuoteChars);
