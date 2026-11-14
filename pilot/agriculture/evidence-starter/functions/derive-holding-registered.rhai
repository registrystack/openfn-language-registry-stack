fn derive(facts, selectors, context) {
    required(facts["local-identifier"], "identifier_missing");
    [#{output: "registered", value: true}]
}
