import os
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"message": "Hello from FastAPI on LevantDeploy", "env": os.getenv("LEVANT_ENV", "local")}


@app.get("/health")
def health():
    return {"ok": True}
