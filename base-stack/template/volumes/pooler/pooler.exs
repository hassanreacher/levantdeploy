{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => System.get_env("POOLER_TENANT_ID"),
  "db_host" => System.get_env("POSTGRES_HOST") || "db",
  "db_port" => System.get_env("POSTGRES_PORT"),
  "db_database" => System.get_env("POSTGRES_DB"),
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => System.get_env("POOLER_MAX_CLIENT_CONN"),
  "default_pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
  "default_parameter_status" => %{"server_version" => version},
  # LEVANTBASE: TLS required for clients when a public DB port is enabled (Supavisor terminates TLS with
  # GLOBAL_DOWNSTREAM_CERT_PATH / _KEY_PATH, a per-project self-signed certificate)
  "enforce_ssl" => System.get_env("POOLER_ENFORCE_SSL") == "true",
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => System.get_env("POSTGRES_PASSWORD"),
    "mode_type" => System.get_env("POOLER_POOL_MODE"),
    "pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
    "is_manager" => true
  }]
}

case Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  nil ->
    {:ok, _} = Supavisor.Tenants.create_tenant(params)

  # LEVANTBASE: keep enforce_ssl in sync on every start (upstream only creates the tenant once)
  tenant ->
    {:ok, _} = Supavisor.Tenants.update_tenant(tenant, %{"enforce_ssl" => params["enforce_ssl"]})
end
