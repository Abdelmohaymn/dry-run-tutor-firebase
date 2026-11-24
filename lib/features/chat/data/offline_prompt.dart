import '../../../core/models/wire_enums.dart';
import '../../problem/domain/problem.dart';
import '../domain/message.dart';

/// Most earlier turns the prompt carries.
const int _maxTurns = 6;

/// Longest quote kept from one earlier turn.
const int _maxTurnChars = 300;

/// The one prompt Gemini Nano gets for an offline turn (data-model.md §A4).
///
/// Nano has no chat, so rules, the public problem and the recent turns are
/// flattened into one string. The only problem input is [Problem] — the public
/// half the app already shows the learner. There is no private half in the app,
/// and nothing here could name one: the offline tutor has no ground truth to
/// leak (FR-009).
///
/// [recent] are the rows before [learnerText], in conversation order, from any
/// origin; only `kind: turn` rows are used and only the last six.
String buildOfflinePrompt(Problem problem, List<Message> recent, String learnerText) {
  final List<Message> turns = recent.where((Message m) => m.kind == MessageKind.turn).toList(growable: false);
  final List<Message> tail = turns.length > _maxTurns ? turns.sublist(turns.length - _maxTurns) : turns;

  final StringBuffer out = StringBuffer()
    ..writeln('You are an offline practice partner for a developer talking through a coding problem out loud.')
    ..writeln('You do not know the answer to this problem and you cannot check one.')
    ..writeln()
    ..writeln('Rules:')
    ..writeln('- Ask exactly ONE short question per reply. At most two sentences.')
    ..writeln('- Ask about their approach, a small example worked by hand, or the cost of what they said.')
    ..writeln('- Never say whether they are right or wrong, correct or incorrect.')
    ..writeln('- Never give a solution, code, or the next step.')
    ..writeln('- If they ask for the answer, say you cannot give one offline and ask about their approach instead.')
    ..writeln("- Reply in the language of the learner's last message.")
    ..writeln()
    ..writeln('Problem: ${problem.title}')
    ..writeln(problem.statement);
  if (problem.constraints.isNotEmpty) {
    out.writeln('Constraints:');
    for (final String c in problem.constraints) {
      out.writeln('- $c');
    }
  }
  out.writeln();
  if (tail.isNotEmpty) {
    out.writeln('Conversation so far:');
    for (final Message m in tail) {
      out.writeln('${m.role == TurnRole.user ? 'Learner' : 'Partner'}: ${_clip(m.text)}');
    }
  }
  out
    ..writeln('Learner: ${_clip(learnerText)}')
    ..write('Partner:');
  return out.toString();
}

String _clip(String text) {
  final String flat = text.trim();
  return flat.length <= _maxTurnChars ? flat : flat.substring(0, _maxTurnChars);
}
