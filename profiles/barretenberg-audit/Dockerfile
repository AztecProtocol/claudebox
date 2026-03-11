# Barretenberg Audit Image — extends devbox with formal verification tools.
#
# Tools added:
#   - OCaml + dune (CryptoLine build system)
#   - Singular (free CAS backend for CryptoLine)
#   - Z3 (SMT solver), Boolector (SMT)
#   - ABC (equivalence checker for CryptoLine)
#   - APRON + mlgmpidl (abstract interpretation for CryptoLine)
#   - CryptoLine (assembly verification: github.com/fmlab-iis/cryptoline)
#   - Lean4 via elan + mathlib4
#
# Build:
#   docker build -t audit-devbox:latest -f profiles/barretenberg-audit/Dockerfile .
#
ARG BASE_IMAGE=aztecprotocol/devbox:3.0
FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-l", "-c"]

# ── System packages ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        # OCaml toolchain + dune build system
        ocaml ocaml-dune camlidl \
        # OCaml libraries (CryptoLine deps)
        libzarith-ocaml-dev liblwt-ocaml-dev libppx-optcomp-ocaml-dev \
        libbigarray-compat-ocaml-dev \
        # CAS + SMT
        singular z3 \
        # C build deps for APRON/mlgmpidl/abc/CryptoLine
        libgmp-dev libmpfr-dev libppl-dev libglpk-dev libflint-dev \
        libmpc-dev libreadline-dev pkg-config cmake bc \
        # Python deps for CryptoLine MIP solvers
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ── ABC (equivalence checker) ───────────────────────────────────
RUN git clone --depth 1 https://github.com/berkeley-abc/abc.git /tmp/abc \
    && cd /tmp/abc && make -j$(nproc) \
    && install -m 755 -s abc /usr/local/bin/ \
    && cd / && rm -rf /tmp/abc

# ── mlgmpidl + APRON (abstract interpretation for CryptoLine) ───
RUN git clone --depth 1 --branch 1.3.0 https://github.com/nberth/mlgmpidl.git /tmp/mlgmpidl \
    && cd /tmp/mlgmpidl && ./configure && make && make install \
    && cd / && rm -rf /tmp/mlgmpidl

RUN git clone --depth 1 https://github.com/antoinemine/apron.git /tmp/apron \
    && cd /tmp/apron && ./configure && make && make install \
    && cd / && rm -rf /tmp/apron

# ── CryptoLine ──────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/fmlab-iis/cryptoline.git /opt/cryptoline \
    && cd /opt/cryptoline \
    && APRON_DIR=$(ocamlfind query apron)/.. \
    && mkdir -p $APRON_DIR/camlidl/caml \
    && cp $(ocamlc -where)/com.* $APRON_DIR/camlidl/ \
    && cp $(ocamlc -where)/libcamlidl.a $APRON_DIR/camlidl/ \
    && cp $(ocamlc -where)/caml/camlidlruntime.h $APRON_DIR/camlidl/caml/ \
    && cp $(ocamlc -where)/METAS/META.camlidl $APRON_DIR/camlidl/META \
    && export OCAMLPATH=$APRON_DIR \
    && dune build && dune install --prefix /usr/local \
    && ./scripts/install-boolector.sh

# Persist OCAMLPATH for CryptoLine's apron bindings
RUN echo "export OCAMLPATH=$(ocamlfind query apron)/.." >> /etc/zsh/zshenv \
    && echo "export OCAMLPATH=$(ocamlfind query apron)/.." >> /etc/bash.bashrc

# ── Lean4 via elan (latest stable) ──────────────────────────────
ENV ELAN_HOME=/opt/elan
ENV PATH="/opt/elan/bin:${PATH}"
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --no-modify-path --default-toolchain stable \
    && chmod -R a+rwx /opt/elan

# ── Pre-fetch mathlib4 (large, cache in image) ──────────────────
RUN git clone https://github.com/leanprover-community/mathlib4.git /opt/mathlib4

# Reset to non-root
USER aztec-dev
