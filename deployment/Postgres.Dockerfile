FROM postgres:17.11@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675
COPY --chmod=755 deployment/postgres-tls-entrypoint.sh /usr/local/bin/pilot-postgres-entrypoint
ENTRYPOINT ["/usr/local/bin/pilot-postgres-entrypoint"]
CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/var/lib/postgresql/tls/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/tls/server.key"]
