# Service cleanup and completion reliability rollout

These source changes are not a release or a server rollout.

Deploy the control-plane changes before upgrading agents. `delete_service` work is
withheld unless the registered/heartbeat capabilities include both `cleanupProofV1`
and `serviceScopedCleanupV1`. Older agents keep deletion pending and the service row
is retained; upgrading the agent and sending a heartbeat makes the work leaseable.
An old in-flight completion lacking the scoped attestation is rejected, not treated
as successful deletion. No database migration is required (capabilities are JSON).

The new agent retains the v1 identifier/image proof and adds
`serviceContainers: { serviceId, remainingContainerIds: [] }`. It enumerates managed
containers for the service, including stopped and stale-deployment containers, removes
them, then enumerates again before attesting absence. The API requires the matching
service scope and empty remaining list; a null predicted identifier is not proof.
Deployment removal (`remove_app`) enumerates only that service's target deployment.
Unmanaged containers and other services/deployments are not removal targets.

Completion reports send up to four attempts on transient errors with 1/2/4-second delays;
lease renewal continues through reporting. A lost response may follow a committed
completion and does not authorize rollback. Re-leased app deployment adopts its own
running deterministic candidate only after ownership, image, volume, readiness and
routing checks; conflicting state fails safely. The local `rollout.reusedCandidate`
marker prevents a later sanitizer/content rejection from deleting that adopted
candidate; it does not assert that the control plane committed an earlier result. There is no durable local report
journal: prolonged outages still require control-plane retry/reconciliation.

Previous-container retirement gets three bounded attempts. If all fail, the new
healthy deployment remains running and the service shows a cleanup warning. No
background sweeper is introduced: leftovers remain until explicit service cleanup.

Invalid or stale service metrics are discarded per sample without dropping valid
host/service samples. Logs contain a bounded count-only diagnostic: unknown IDs are
suspected stale runtime, not proof of ownership or compromise. Database failures
still fail ingestion.

Local regression coverage uses Docker fakes and HTTP route injection, not a live
Docker daemon or production server. Real Docker/release/rollout verification remains
necessary before claiming server-verified behavior.
