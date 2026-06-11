# Homebrew formula for HybridClaw.
#
# Installs the published npm tarball (which ships the prebuilt dist/), so the
# formula needs no TypeScript build. Served through the tap repo at
# https://github.com/HybridAIOne/homebrew-hybridclaw (to be created):
#
#   brew tap hybridaione/hybridclaw
#   brew install hybridclaw
#
# On each release, bump `url`/`sha256` to the new registry tarball:
#   curl -fsSL https://registry.npmjs.org/@hybridaione/hybridclaw/-/hybridclaw-<ver>.tgz | shasum -a 256
class Hybridclaw < Formula
  desc "Enterprise-ready self-hosted AI assistant runtime"
  homepage "https://github.com/HybridAIOne/hybridclaw"
  url "https://registry.npmjs.org/@hybridaione/hybridclaw/-/hybridclaw-0.23.0.tgz"
  sha256 "dda8728b0be65273ad5f545c01befc0d7b643d6bcaac73ee2614981ab2b5969c"
  license "MIT"

  depends_on "node@22"
  depends_on "python@3.12" => :build
  depends_on "pkg-config" => :build

  def install
    # Build native modules (and run the package's container bootstrap) against
    # the keg-only node@22, not whatever node happens to be linked.
    ENV.prepend_path "PATH", Formula["node@22"].opt_bin
    system "npm", "install", *std_npm_args
    # node@22 is keg-only, so the `#!/usr/bin/env node` bin stubs would resolve
    # a wrong-major (or missing) node at runtime without this wrapper.
    libexec.glob("bin/*") do |f|
      (bin/f.basename).write_env_script f, PATH: "#{Formula["node@22"].opt_bin}:${PATH}"
    end
  end

  def caveats
    <<~EOS
      HybridClaw uses Docker for the default container sandbox mode. Install
      Docker Desktop or colima and ensure it is running before starting the
      gateway:

        hybridclaw gateway start --foreground

      Configuration lives under ~/.hybridclaw/.
    EOS
  end

  test do
    # The CLI prints the bare semver.
    assert_match version.to_s, shell_output("#{bin}/hybridclaw --version")
  end
end
