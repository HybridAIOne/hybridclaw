# Homebrew formula prep for HybridClaw.
#
# This formula is currently HEAD-only. Stable `brew install hybridclaw`
# will start working once a signed GitHub release tarball is published and
# the `url`/`sha256` block below is filled in. Until then, contributors
# and early adopters can use:
#
#   brew install --HEAD hybridaione/hybridclaw/hybridclaw
#
# The tap repo lives at https://github.com/HybridAIOne/homebrew-hybridclaw
# (to be created). Once a release exists, uncomment the `url` + `sha256`
# lines and drop the `head` line if preferred, then:
#
#   brew tap hybridaione/hybridclaw
#   brew install hybridclaw
class Hybridclaw < Formula
  desc "Enterprise-ready self-hosted AI assistant runtime"
  homepage "https://github.com/HybridAIOne/hybridclaw"
  head "https://github.com/HybridAIOne/hybridclaw.git", branch: "main"
  license "MIT"

  # Uncomment once a signed GitHub release tarball is published:
  # url "https://github.com/HybridAIOne/hybridclaw/archive/refs/tags/v0.12.11.tar.gz"
  # sha256 "REPLACE_WITH_TARBALL_SHA256"

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
