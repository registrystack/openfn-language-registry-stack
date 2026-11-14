// Generated from the compiled registry. Review before changing.
fn select_fields(exchange) {
    let inputs = exchange.body;
    if inputs.contains("by-local-identifier--local-identifier") { return "localIdentifier"; }
    throw "unsupported source selector profile";
}

fn prepare_request(exchange) {
    let inputs = exchange.body;
    if inputs.contains("by-local-identifier--local-identifier") { return #{selector: "by-local-identifier", values: #{"localIdentifier": inputs["by-local-identifier--local-identifier"]}}; }
    throw "unsupported source selector profile";
}

fn project_response(exchange) {
    let record = exchange.body["data"]["domainData"];
    let projected = #{};
    if record.contains("localIdentifier") { projected["localIdentifier"] = record["localIdentifier"]; }
    #{data: #{domainData: projected}}
}

// Identity is checked once, before facts can feed any question.
fn lookup(exchange) {
    let inputs = exchange.properties["bregEvidenceInputs"];
    let record = exchange.body["data"]["domainData"];
    if inputs.contains("by-local-identifier--local-identifier") {
        if record["localIdentifier"] == () || type_of(record["localIdentifier"]) != type_of(inputs["by-local-identifier--local-identifier"]) || record["localIdentifier"] != inputs["by-local-identifier--local-identifier"] { throw "source_protocol_error"; }
    } else { throw "unsupported source selector profile"; }
    if record["localIdentifier"] == () { return #{lookup: "no-match"}; }
    #{lookup: "matched", facts: #{"local-identifier": record["localIdentifier"]}}
}
fn is_unresolved(exchange) {
    exchange.headers["camelhttpresponsecode"] == 404
}
