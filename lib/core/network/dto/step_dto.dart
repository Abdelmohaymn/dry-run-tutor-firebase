/// Wire shapes of the relay step protocol — contracts/relay-steps.md.
///
/// Hand-parsed on purpose: these never touch disk, and a call's `system` and
/// `messages` may carry ground truth (FR-006), so nothing here may log or
/// persist them. `toString` is deliberately not overridden with field values.
library;

/// One chat message inside a [ModelCallDto]. `role` is `user` or `model`.
class StepMessageDto {
  const StepMessageDto({required this.role, required this.text});

  factory StepMessageDto.fromJson(Map<String, dynamic> json) =>
      StepMessageDto(role: json['role'] as String, text: json['text'] as String);

  final String role;
  final String text;

  @override
  String toString() => 'StepMessageDto(role: $role)';
}

/// `output` of a call: free text, or JSON constrained by [schema].
class ModelOutputDto {
  const ModelOutputDto({required this.kind, this.schema});

  factory ModelOutputDto.fromJson(Map<String, dynamic> json) => ModelOutputDto(
    kind: json['kind'] as String,
    schema: json['schema'] == null ? null : Map<String, dynamic>.from(json['schema'] as Map),
  );

  /// `text` or `json`.
  final String kind;
  final Map<String, dynamic>? schema;

  bool get isJson => kind == 'json';
}

/// A model call the relay wants the app to make (relay → app).
class ModelCallDto {
  const ModelCallDto({
    required this.id,
    required this.purpose,
    required this.model,
    required this.system,
    required this.messages,
    required this.output,
    required this.maxOutputTokens,
    required this.temperature,
    required this.timeoutMs,
    required this.required,
    this.thinkingBudget,
  });

  factory ModelCallDto.fromJson(Map<String, dynamic> json) => ModelCallDto(
    id: json['id'] as String,
    purpose: json['purpose'] as String,
    model: json['model'] as String,
    system: json['system'] as String,
    messages: <StepMessageDto>[
      for (final Object? m in json['messages'] as List<Object?>) StepMessageDto.fromJson(m! as Map<String, dynamic>),
    ],
    output: ModelOutputDto.fromJson(json['output'] as Map<String, dynamic>),
    maxOutputTokens: (json['max_output_tokens'] as num).toInt(),
    temperature: (json['temperature'] as num).toDouble(),
    thinkingBudget: (json['thinking_budget'] as num?)?.toInt(),
    timeoutMs: (json['timeout_ms'] as num).toInt(),
    required: json['required'] as bool,
  );

  final String id;
  final String purpose;
  final String model;
  final String system;
  final List<StepMessageDto> messages;
  final ModelOutputDto output;
  final int maxOutputTokens;
  final double temperature;

  /// `null` means the model's default.
  final int? thinkingBudget;
  final int timeoutMs;

  /// A failed required call stops the loop; an optional one is answered with an error.
  final bool required;

  /// Never prints `system` or `messages`.
  @override
  String toString() => 'ModelCallDto(id: $id, purpose: $purpose)';
}

/// The relay's reply to a step POST: more calls to make, or the finished result.
class StepResponseDto {
  const StepResponseDto.model(List<ModelCallDto> this.calls) : done = null;
  const StepResponseDto.done(Map<String, dynamic> this.done) : calls = null;

  factory StepResponseDto.fromJson(Map<String, dynamic> json) {
    switch (json['status']) {
      case 'model':
        return StepResponseDto.model(<ModelCallDto>[
          for (final Object? c in json['calls'] as List<Object?>) ModelCallDto.fromJson(c! as Map<String, dynamic>),
        ]);
      case 'done':
        return StepResponseDto.done(json);
      default:
        throw const FormatException('Unknown step status');
    }
  }

  /// Non-null when the relay wants model calls made.
  final List<ModelCallDto>? calls;

  /// The whole `done` body (including `status`), for the endpoint's own parser.
  final Map<String, dynamic>? done;

  bool get isDone => done != null;
}
