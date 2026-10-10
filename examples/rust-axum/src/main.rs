use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let app = Router::new()
        .route("/", get(|| async { "Hello from Rust (axum) on LevantDeploy\n" }))
        .route("/health", get(|| async { "{\"ok\":true}" }));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    println!("listening on :{port}");
    axum::serve(listener, app).await.unwrap();
}
