{
  description = "Xordi Enclave - Deterministic builds with Nix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Shared Node.js app build (TypeScript -> JavaScript)
        tokscopeEnclave = pkgs.buildNpmPackage {
          pname = "tokscope-enclave";
          version = "1.0.0";

          src = ./.;

          # npm dependency hash
          npmDepsHash = "sha256-oC55ItJDb7SOf+6EVmq4UOGhzAXXyI7NQfMvJO59Tz4=";

          # Build TypeScript
          buildPhase = ''
            npm run build
          '';

          # Install built JavaScript
          installPhase = ''
            mkdir -p $out/lib/tokscope-enclave
            cp -r dist/* $out/lib/tokscope-enclave/
            cp -r node_modules $out/lib/tokscope-enclave/
            cp package.json $out/lib/tokscope-enclave/
          '';

          # Reproducible timestamp from git
          SOURCE_DATE_EPOCH = "1759191829";
        };

        # API Docker image
        apiImage = pkgs.dockerTools.buildImage {
          name = "tokscope-enclave-api";
          tag = "latest";

          contents = with pkgs; [
            tokscopeEnclave
            nodejs_18
            socat
            bashInteractive
            coreutils
          ];

          config = {
            Cmd = [ "${pkgs.nodejs_18}/bin/node" "${tokscopeEnclave}/lib/tokscope-enclave/server.js" ];
            WorkingDir = "${tokscopeEnclave}/lib/tokscope-enclave";
            ExposedPorts = { "3000/tcp" = {}; };
            Env = [
              "NODE_ENV=production"
              "PATH=${pkgs.nodejs_18}/bin:${pkgs.socat}/bin"
            ];
          };

          created = "1970-01-01T00:00:01Z";
        };

        # Manager Docker image
        managerImage = pkgs.dockerTools.buildImage {
          name = "tokscope-enclave-manager";
          tag = "latest";

          contents = with pkgs; [
            tokscopeEnclave
            nodejs_18
            docker
            curl
            cacert
            bashInteractive
            coreutils
          ];

          config = {
            Cmd = [ "${pkgs.nodejs_18}/bin/node" "${tokscopeEnclave}/lib/tokscope-enclave/browser-manager.js" ];
            WorkingDir = "${tokscopeEnclave}/lib/tokscope-enclave";
            Env = [
              "NODE_ENV=production"
              "DOCKER_HOST=unix:///var/run/docker.sock"
              "PATH=${pkgs.nodejs_18}/bin:${pkgs.docker}/bin:${pkgs.curl}/bin"
            ];
          };

          created = "1970-01-01T00:00:01Z";
        };

      in {
        packages = {
          default = tokscopeEnclave;
          app = tokscopeEnclave;
          api-image = apiImage;
          manager-image = managerImage;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs_18 docker ];
        };
      });
}