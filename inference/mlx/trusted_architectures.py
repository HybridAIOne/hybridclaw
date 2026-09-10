"""Only packaged model implementations run; checkpoint Python is never imported.

Spark retains upstream Transformers metadata, but this exact artifact uses the
separately pinned XHToken extension. This is not trust_remote_code support.
"""

SPARK_ARTIFACT = (
    "abenzerps/Spark-X2.5-4B-MLX-4bit",
    "b23819d4d60c2767fbf6ee3b3527f5f33205be7e",
)
SPARK_AUTO_MAP = {
    "AutoConfig": "configuration_spark.Spark2_5Config",
    "AutoModel": "modeling_spark.Spark2_5Model",
    "AutoModelForCausalLM": "modeling_spark.Spark2_5ForCausalLM",
}


def validate_model_code(config, tokenizer, repo, revision):
    if tokenizer.get("auto_map") or config.get("model_file"):
        raise ValueError("Remote model/tokenizer code is not supported")
    if config.get("auto_map") and not (
        (repo, revision) == SPARK_ARTIFACT
        and config.get("model_type") == "spark2_5"
        and config["auto_map"] == SPARK_AUTO_MAP
    ):
        raise ValueError("Remote model/tokenizer code is not supported")


def register_packaged_model(config):
    if config.get("model_type") == "spark2_5":
        from spark_mlx_llm.registration import register_model

        register_model()
