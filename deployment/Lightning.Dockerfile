# syntax=docker/dockerfile:1
ARG LIGHTNING_IMAGE=openfn/lightning:v2.18.2@sha256:a2327173ece7b5ac4904744acf63f928dd2cbe496788d31266060e85bd359203
ARG ADAPTORS_IMAGE=registry-openfn-worker:pilot
FROM ${ADAPTORS_IMAGE} AS adaptors
FROM ${LIGHTNING_IMAGE}
COPY --from=adaptors --chown=lightning:root /opt/registry-adaptors /opt/registry-adaptors
ENV OPENFN_ADAPTORS_REPO=/opt/registry-adaptors
ENV LOCAL_ADAPTORS=true
