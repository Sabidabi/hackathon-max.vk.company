FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PYTHONPATH=/app

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-rus \
    && rm -rf /var/lib/apt/lists/*

COPY certs/russian_trusted_root_ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

RUN mkdir -p /data/uploads /data/rendered /data/extracted /data/menu-images \
    && chown -R 10001:10001 /app /data

FROM base AS test

USER root
COPY requirements-dev.txt ./
COPY pyproject.toml ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests ./tests

USER 10001:10001

CMD ["pytest", "-q"]

FROM base AS runtime

USER 10001:10001

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
