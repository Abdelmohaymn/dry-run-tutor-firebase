import 'dart:io';

import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/features/chat/data/offline_prompt.dart';
import 'package:dry_run/features/chat/domain/message.dart';
import 'package:dry_run/features/problem/domain/problem.dart';
import 'package:flutter_test/flutter_test.dart';

const Problem _problem = Problem(
  schemaVersion: 2,
  id: 'vp-0001',
  title: 'Two Sum',
  ramp: 'easy',
  tags: <String>[],
  source: 'authored',
  statement: 'Given an array of integers, return the positions of two that add up to the target.',
  constraints: <String>['2 <= n <= 10^4', 'exactly one answer'],
  estSpeakSeconds: 60,
  collections: <String>[],
  glossaryTerms: <String>[],
  hintCount: 3,
);

Message _turn(int seq, TurnRole role, String text) =>
    Message(id: 'm$seq', seq: seq, role: role, text: text, kind: MessageKind.turn, delivery: Delivery.sent);

void main() {
  test('carries the rules, the public problem and the new learner turn', () {
    final String prompt = buildOfflinePrompt(_problem, const <Message>[], 'I would check every pair.');
    expect(prompt, contains('ONE short question'));
    expect(prompt, contains('Never say whether they are right or wrong'));
    expect(prompt, contains('Never give a solution'));
    expect(prompt, contains('Two Sum'));
    expect(prompt, contains('return the positions of two'));
    expect(prompt, contains('- 2 <= n <= 10^4'));
    expect(prompt, endsWith('Learner: I would check every pair.\nPartner:'));
  });

  test('keeps only the last six turns, each cut to 300 characters', () {
    final List<Message> recent = <Message>[
      for (int i = 0; i < 9; i++) _turn(i, i.isEven ? TurnRole.user : TurnRole.tutor, 'turn-$i ${'x' * 400}'),
    ];
    final String prompt = buildOfflinePrompt(_problem, recent, 'next');
    expect(prompt, isNot(contains('turn-0 ')));
    expect(prompt, isNot(contains('turn-2 ')));
    expect(prompt, contains('turn-3 '));
    expect(prompt, contains('turn-8 '));
    expect(prompt, isNot(contains('x' * 301)));
    expect(prompt, contains('Learner: turn-8'));
    expect(prompt, contains('Partner: turn-7'));
  });

  test('uses only kind: turn rows', () {
    final String prompt = buildOfflinePrompt(_problem, <Message>[
      const Message(
        id: 'h',
        seq: 0,
        role: TurnRole.tutor,
        text: 'A HINT RUNG',
        kind: MessageKind.hintRung,
        delivery: Delivery.sent,
      ),
    ], 'hi');
    expect(prompt, isNot(contains('A HINT RUNG')));
  });

  test('has no way to name a private field: its only problem input is the public Problem', () {
    // Code only: the doc comments are allowed to say what the function never sees.
    final String source = File('lib/features/chat/data/offline_prompt.dart')
        .readAsLinesSync()
        .where((String l) => !l.trimLeft().startsWith('//'))
        .join('\n');
    final RegExp signature = RegExp(r'String buildOfflinePrompt\(([^)]*)\)');
    expect(signature.firstMatch(source)!.group(1), 'Problem problem, List<Message> recent, String learnerText');
    for (final String forbidden in <String>['never_say', 'neverSay', 'key_insights', 'keyInsights', 'editorial', 'ground', 'reference_approach']) {
      expect(source.toLowerCase(), isNot(contains(forbidden.toLowerCase())), reason: forbidden);
    }
  });
}
