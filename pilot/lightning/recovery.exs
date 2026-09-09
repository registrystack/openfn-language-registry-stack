# Bounded operator inspection/retry for this pilot only. Invoked through the
# unmodified v2.18.2 release RPC. WorkOrders.retry is the owning context used by
# WorkflowController.retry_run; no direct SQL mutations or replacement dataclips.
import Ecto.Query

request = pilot_recovery_request |> Jason.decode!()
secret_root = System.get_env("PILOT_SECRET_ROOT", "/run/pilot-secrets")
config = Path.join(secret_root, "project.json") |> File.read!() |> Jason.decode!()
project = Lightning.Projects.get_project!(config["projectId"])
if project.name != "registry-agriculture-pilot", do: raise("Unexpected pilot project")
trigger = Lightning.Workflows.get_webhook_trigger(config["triggerIds"]["committed"])
if is_nil(trigger), do: raise("Pilot committed trigger is unavailable")
workflow = Lightning.Workflows.get_workflow!(trigger.workflow_id)
if workflow.project_id != project.id, do: raise("Unexpected pilot workflow")
record_id = request["recordId"]
if not is_binary(record_id) or not Regex.match?(~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, record_id),
  do: raise("Expected a synthetic record identity")

identities = Lightning.Repo.all(from order in Lightning.WorkOrder,
  join: dataclip in assoc(order, :dataclip),
  where: order.workflow_id == ^workflow.id and
    fragment("?->'data'->>'recordId'", dataclip.body) == ^record_id,
  order_by: [asc: order.inserted_at], limit: 20,
  select: {order.id, fragment("?->'event'->>'id'", dataclip.body),
    fragment("?->'delivery'->'generation'", dataclip.body)})
# Dataclip.body is deliberately excluded from ordinary Ecto loads. Select only
# the two identity members needed here, without loading or logging the payload.
orders = Enum.map(identities, fn {id, _, _} ->
  Lightning.WorkOrders.get(id, include: [runs: [steps: :job]])
end)
identity_by_order = Map.new(identities, fn {id, event, generation} -> {id, {event, generation}} end)

terminal_failures = [:failed, :crashed, :killed, :cancelled, :exception, :lost]
result = case request["action"] do
  "inspect" ->
    %{workOrders: Enum.map(orders, fn order ->
      %{id: order.id, state: order.state, eventId: elem(identity_by_order[order.id], 0),
        generation: elem(identity_by_order[order.id], 1),
        runs: order.runs |> Enum.sort_by(& &1.inserted_at, DateTime) |> Enum.map(fn run ->
          %{id: run.id, state: run.state, queue: run.queue, steps: Enum.map(run.steps, fn step ->
            %{id: step.id, job: step.job.name, exitReason: step.exit_reason}
          end)}
        end)}
    end)}
  "retry" ->
    order = Enum.find(orders, &(&1.id == request["workOrderId"]))
    if is_nil(order) or order.state not in terminal_failures,
      do: raise("Expected one failed pilot work order")
    run = Enum.max_by(order.runs, & &1.inserted_at, DateTime)
    if run.id != request["expectedRunId"] or run.state not in terminal_failures,
      do: raise("Pilot run changed before retry")
    failed_steps = Enum.filter(run.steps, &(&1.exit_reason in ["fail", "crash", "cancel", "kill", "exception", "lost"]))
    if length(failed_steps) != 1, do: raise("Expected one failed retained step")
    step = hd(failed_steps)
    if step.job.name not in ["verify-registration", "record-update"],
      do: raise("Unexpected failed pilot step")
    operator = Path.join(secret_root, "operator.json") |> File.read!() |> Jason.decode!()
    user = Lightning.Accounts.get_user_by_email(operator["email"])
    if is_nil(user), do: raise("Pilot operator is unavailable")
    :ok = Lightning.WorkOrders.limit_run_creation(project.id)
    {:ok, retry} = Lightning.WorkOrders.retry(run.id, step.id, created_by: user)
    %{workOrderId: order.id, previousRunId: run.id, runId: retry.id, retriedJob: step.job.name}
  _ -> raise("Unsupported pilot recovery operation")
end
IO.puts("PILOT_RECOVERY_JSON:" <> Jason.encode!(result))
:ok
