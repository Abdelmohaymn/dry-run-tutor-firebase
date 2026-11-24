import 'dart:convert';
import 'dart:io';

import 'package:dry_run/core/ai/schema_converter.dart';
import 'package:firebase_ai/firebase_ai.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('converts the relay judge schema: required vs optional, enums, nullable', () {
    final Map<String, dynamic> json =
        jsonDecode(File('test/fixtures/judge_schema.json').readAsStringSync()) as Map<String, dynamic>;
    final Map<String, dynamic> out = toFirebaseSchema(json).toJson();

    expect(out['type'], 'OBJECT');
    final Map<String, dynamic> props = out['properties'] as Map<String, dynamic>;
    expect(props.keys, containsAll(<String>['approach_quote', 'matched_approach', 'complexity', 'verdict']));
    // Everything the relay marks required stays required (Gemini treats the rest as optional).
    expect(out['required'], containsAll(<String>['approach_quote', 'verdict', 'feedback']));
    expect((props['matched_approach'] as Map<String, dynamic>)['enum'], contains('none'));
    final Map<String, dynamic> claimed =
        ((props['complexity'] as Map<String, dynamic>)['properties'] as Map<String, dynamic>)['user_claimed_time']
            as Map<String, dynamic>;
    expect(claimed['nullable'], true);
  });

  test('scalars, arrays and enums', () {
    expect(toFirebaseSchema(<String, dynamic>{'type': 'integer'}).type, SchemaType.integer);
    expect(
      toFirebaseSchema(<String, dynamic>{
        'type': 'array',
        'items': <String, dynamic>{'type': 'boolean'},
      }).type,
      SchemaType.array,
    );
    final Schema e = toFirebaseSchema(<String, dynamic>{
      'type': 'string',
      'enum': <String>['a', 'b'],
    });
    expect(e.enumValues, <String>['a', 'b']);
  });

  test('rejects a type outside the subset', () {
    expect(() => toFirebaseSchema(<String, dynamic>{'type': 'null'}), throwsFormatException);
  });
}
