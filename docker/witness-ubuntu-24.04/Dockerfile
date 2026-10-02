FROM ubuntu:24.04

# The ci.yml csp-witness job as a local environment: the same distro, the same apt line,
# the same toolchains, the same driver. Mount the repository, build the desktop, and run
# a witness on this machine — where an app that will not answer a session says why on our
# own screen instead of in a CI log.
#
# See README.md beside this file for the run commands.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg file unzip xz-utils \
        build-essential \
        dbus xvfb \
        libwebkit2gtk-4.1-dev webkit2gtk-driver \
        libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
        python3 python3-pip \
        git pkg-config \
    && rm -rf /var/lib/apt/lists/*

# The same toolchains the job sets up: rust stable, node 24, bun, uv.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# The driver, compiled once into the image.
RUN cargo install tauri-driver --locked

WORKDIR /work
