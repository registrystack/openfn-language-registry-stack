// Legacy pre-v0.45 location, retained but not referenced by evidence.yaml.
fn derive(facts, selectors, context) {
    required(facts["local-identifier"], "identifier_missing");
    [#{output: "registered", value: true}]
}
