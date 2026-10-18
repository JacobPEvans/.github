{
  description = "dryvist org-wide config + reusable Nix dev-hygiene flake-module";

  # Lean by design: only what the dev-hygiene module needs (no devenv /
  # crate2nix / devshell), so consumers importing flakeModules.dev-hygiene get
  # a small flake.lock closure. Plain-source consumers (flake = false, e.g. for
  # zizmor.yml) are unaffected by this flake.nix.
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, ... }@inputs:
    {
      # Reusable flake-parts modules for consuming Nix repos. The dev-hygiene
      # module is pre-bound to this repo's treefmt-nix/git-hooks and its own
      # zizmor.yml; see nix/dev-hygiene.nix for the consumer snippet.
      flakeModules.dev-hygiene = import ./nix/dev-hygiene.nix {
        inherit (inputs) treefmt-nix git-hooks;
        zizmorConfig = "${self}/zizmor.yml";
      };

      # Shared check for the per-CLI AI repos (nix-claude-code, nix-codex,
      # nix-agy): autonomous agent config must never render onto a host
      # filesystem. A plain function, not a flake-parts module, because
      # those repos are plain flakes. Lives here rather than in nix-ai
      # because nix-ai consumes nix-claude-code, so a leaf importing nix-ai
      # would be a circular flake input.
      lib.autonomousContainment = import ./nix/autonomous-containment.nix;

      # `nix flake check` does not evaluate `lib.` outputs, so the check
      # above would ship with nothing exercising it. This runs the same
      # scanner against clean / violating / empty / flag-shaped /
      # allowlisted fixtures.
      #
      # Scoped to the CI system deliberately. The scan is pure bash+grep
      # over source, so its result is system-independent — exposing it for
      # all four systems only made `nix flake check --all-systems` try to
      # build darwin derivations on a linux runner and fail with "Cannot
      # build". This is the "scope source-only checks to the CI system"
      # case called out in _ci-gate.yml's `all_systems` docs.
      checks.x86_64-linux.autonomous-containment-selftest =
        import ./nix/autonomous-containment-selftest.nix {
          pkgs = inputs.nixpkgs.legacyPackages.x86_64-linux;
        };

    };
}
