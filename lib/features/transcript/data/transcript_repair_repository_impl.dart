import '../../../core/errors/result.dart';
import '../../../core/network/dto/repair_dto.dart';
import '../../../core/network/relay_client.dart';
import '../../chat/data/step_loop.dart';
import '../../chat/domain/session.dart';
import '../../onboarding/domain/install_identity.dart';
import '../../onboarding/domain/install_repository.dart';
import '../domain/transcript_repair_repository.dart';

class TranscriptRepairRepositoryImpl implements TranscriptRepairRepository {
  TranscriptRepairRepositoryImpl({
    required RelayClient relayClient,
    required InstallRepository installRepository,
    required StepLoop stepLoop,
  })  : _relayClient = relayClient,
        _installRepository = installRepository,
        _stepLoop = stepLoop;

  final RelayClient _relayClient;
  final InstallRepository _installRepository;
  final StepLoop _stepLoop;

  @override
  Future<String?> repair({required Session session, required String transcript}) async {
    try {
      final Result<InstallIdentity> identity = await _installRepository.ensureIdentity();
      if (identity is Err<InstallIdentity>) return null;
      final String installId = (identity as Ok<InstallIdentity>).value.installId;

      final Map<String, Object?> request =
          RepairRequestDto(problemId: session.problem.id, transcript: transcript).toJson();
      final Map<String, Object?> done = await _stepLoop.run(
        (Map<String, Object?> answers) =>
            _relayClient.repairStep(installId: installId, request: request, answers: answers),
      );
      final RepairResponseDto response = RepairResponseDto.fromJson(done);
      return response.changed ? response.repaired : null;
    } catch (_) {
      // Any failure keeps today's fallback: the transcript goes through unchanged.
      return null;
    }
  }
}
