{
  description = "waltil — client-side limited-color wallpaper maker (plain static site, GitHub Pages ready)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "waltil";
          version = "0.1.0";

          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./index.html ./style.css ./app.js ];
          };

          dontConfigure = true;
          dontBuild = true;
          dontFixup = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp index.html style.css app.js "$out/"
            runHook postInstall
          '';
        };
      });

      apps = forAllSystems (pkgs: {
        # Serve the current working directory (live editing) on http://localhost:8080
        default = {
          type = "app";
          program = toString (pkgs.writeShellScript "waltil-serve" ''
            echo "serving $(pwd) on http://localhost:8080  (Ctrl+C to stop)"
            exec ${pkgs.python3}/bin/python3 -m http.server 8080
          '');
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.python3 # static file server
            pkgs.imagemagick # compare outputs against CLI commands
          ];
          shellHook = ''
            echo "waltil dev shell"
            echo "  nix run        # serve this directory at http://localhost:8080"
            echo "  nix build      # build the static site into ./result/"
          '';
        };
      });
    };
}
