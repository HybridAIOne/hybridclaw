# Homebrew formula prep for HybridClaw.
#
# Once a GitHub release tarball is published, this formula can live in a
# `homebrew-hybridclaw` tap. Update `url` and `sha256` to point at the
# signed release tarball, then:
#
#   brew tap hybridaione/hybridclaw
#   brew install hybridclaw
#
# The tap repo lives at https://github.com/HybridAIOne/homebrew-hybridclaw
# (to be created). For development use `brew install --HEAD hybridclaw` with
# `head "https://github.com/HybridAIOne/hybridclaw.git", branch: "main"`.
class Hybridclaw < Formula
  desc "Enterprise-ready self-hosted AI assistant runtime"
  homepage "https://github.com/HybridAIOne/hybridclaw"
  url "https://registry.npmjs.org/@hybridaione/hybridclaw/-/hybridclaw-0.12.11.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node@22"
  depends_on "python@3.12" => :build
  depends_on "pkg-config" => :build

  uses_from_macos "git"

  def install
    # Install into libexec; Homebrew wraps the CLI into bin/.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
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
    assert_match(/hybridclaw/i, shell_output("#{bin}/hybridclaw --version"))
  end
end
