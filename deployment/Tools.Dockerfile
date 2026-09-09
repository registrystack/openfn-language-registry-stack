# Debian 13 matches the released Linux tools' runtime. PostgreSQL client is
# already supplied by the same pinned image used for the pilot database.
FROM postgres:17.11@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675
# Match the immutable Debian snapshot recorded by the pinned base image.
# Retain signature verification; historical repository metadata has expired.
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260824T000000Z|' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260824T000000Z|' \
      /etc/apt/sources.list.d/debian.sources && \
    rm /etc/apt/sources.list.d/pgdg.list && \
    apt-get -o Acquire::Check-Valid-Until=false -o APT::Update::Error-Mode=any update && \
    apt-get install -y --no-install-recommends python3 python3-yaml curl ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/*
COPY deployment/tools.sha256 /tmp/tools.sha256
RUN set -eu; cd /tmp; \
    for tool in breg bregctl evidence evidencectl mint; do \
      curl --fail --location --retry 3 --output "$tool-v0.27.0-linux-amd64" "https://github.com/registrystack/registry-stack/releases/download/v0.27.0/$tool-v0.27.0-linux-amd64"; \
    done; \
    sha256sum --check tools.sha256; \
    for tool in breg bregctl evidence evidencectl mint; do \
      install -m 0755 "$tool-v0.27.0-linux-amd64" "/usr/local/bin/$tool"; \
      rm "$tool-v0.27.0-linux-amd64"; \
    done
ENTRYPOINT []
CMD ["python3", "--version"]
