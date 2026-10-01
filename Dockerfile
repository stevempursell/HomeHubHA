FROM python:3.13-alpine

RUN apk add --no-cache git \
    && pip install --no-cache-dir aiohttp

WORKDIR /app
COPY server.py /app/server.py
COPY www /app/www

CMD ["python3", "/app/server.py"]
