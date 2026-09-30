FROM ghcr.io/home-assistant/base:latest

RUN apk --no-cache add python3 py3-aiohttp

WORKDIR /app
COPY server.py /app/server.py
COPY www /app/www

CMD ["python3", "/app/server.py"]
