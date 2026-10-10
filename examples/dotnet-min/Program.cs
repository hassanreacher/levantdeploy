var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => "Hello from ASP.NET Core on LevantDeploy");
app.MapGet("/health", () => Results.Json(new { ok = true }));
app.Run();
