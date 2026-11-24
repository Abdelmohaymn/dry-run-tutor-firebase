import 'package:firebase_ai/firebase_ai.dart';

/// Converts the relay's `GeminiSchema` subset (contracts/relay-steps.md) into
/// a firebase_ai [Schema]. Anything outside the subset throws: the relay's
/// tests guarantee it never emits one.
Schema toFirebaseSchema(Map<String, dynamic> json) {
  final Object? type = json['type'];
  final bool? nullable = json['nullable'] == true ? true : null;

  switch (type) {
    case 'object':
      final Map<String, dynamic> raw = (json['properties'] as Map<String, dynamic>?) ?? <String, dynamic>{};
      final Set<String> required = <String>{...((json['required'] as List<Object?>?)?.cast<String>() ?? <String>[])};
      final Map<String, Schema> properties = <String, Schema>{
        for (final MapEntry<String, dynamic> e in raw.entries) e.key: toFirebaseSchema(e.value as Map<String, dynamic>),
      };
      return Schema.object(
        properties: properties,
        optionalProperties: properties.keys.where((String k) => !required.contains(k)).toList(),
        propertyOrdering: raw.keys.toList(),
        nullable: nullable,
      );
    case 'array':
      return Schema.array(items: toFirebaseSchema(json['items']! as Map<String, dynamic>), nullable: nullable);
    case 'string':
      final List<Object?>? values = json['enum'] as List<Object?>?;
      return values == null
          ? Schema.string(nullable: nullable)
          : Schema.enumString(enumValues: values.cast<String>(), nullable: nullable);
    case 'number':
      return Schema.number(nullable: nullable);
    case 'integer':
      return Schema.integer(nullable: nullable);
    case 'boolean':
      return Schema.boolean(nullable: nullable);
    default:
      throw FormatException('Unsupported schema type: $type');
  }
}
