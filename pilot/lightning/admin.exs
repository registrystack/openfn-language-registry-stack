# Run only through the dedicated pilot's release RPC. Uses upstream context
# functions and audits, never direct SQL or a custom Lightning build.
secret_root = System.get_env("PILOT_SECRET_ROOT", "/run/pilot-secrets")
read_json = fn name -> name |> then(&Path.join(secret_root, &1)) |> File.read!() |> Jason.decode!() end
operator = read_json.("operator.json")
user = case Lightning.Accounts.get_user_by_email(operator["email"]) do
  nil ->
    if Lightning.Accounts.has_one_superuser?(), do: raise("Pilot refuses an existing operator database")
    case Lightning.Accounts.register_superuser(operator) do
      {:ok, %{user: user}} -> user
      {:ok, user} -> user
      _ -> raise("Pilot operator setup failed")
    end
  user ->
    if is_nil(Lightning.Accounts.get_user_by_email_and_password(operator["email"], operator["password"])),
      do: raise("Pilot operator credentials do not match")
    user
end
token_path = Path.join(secret_root, "api-token")
unless File.exists?(token_path) do
  token = Lightning.Accounts.generate_api_token(user)
  File.write!(token_path, token)
  File.chmod!(token_path, 0o600)
end

config_path = Path.join(secret_root, "project.json")
if File.exists?(config_path) do
  config = read_json.("project.json")
  project = Lightning.Projects.get_project!(config["projectId"])
  if project.name != "registry-agriculture-pilot", do: raise("Unexpected pilot project")
  {:ok, _} = Lightning.Projects.update_project(project, %{
    retention_policy: :retain_all, history_retention_period: 7, dataclip_retention_period: 7
  }, user)
  for {kind, trigger_id} <- config["triggerIds"] do
    # Submission clients cannot authenticate directly to the trusted event path.
    {name, key_file} = if kind == "committed",
      do: {"Pilot committed events", "committed-api-key"},
      else: {"Pilot incoming events", "webhook-api-key"}
    auth = case Enum.find(Lightning.WebhookAuthMethods.list_for_project(project), &(&1.name == name)) do
      nil ->
        {:ok, method} = Lightning.WebhookAuthMethods.create_auth_method(%{
          name: name, auth_type: :api, project_id: project.id,
          api_key: File.read!(Path.join(secret_root, key_file)) |> String.trim()
        }, actor: user)
        method
      method -> method
    end
    trigger = Lightning.Workflows.get_webhook_trigger(trigger_id)
    if is_nil(trigger), do: raise("Pilot webhook not found")
    {:ok, _} = Lightning.WebhookAuthMethods.update_trigger_auth_methods(trigger, [auth], actor: user)
  end
end
IO.puts("Pilot operator and configured webhook protections are ready.")
:ok
