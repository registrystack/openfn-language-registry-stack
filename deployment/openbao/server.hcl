ui = false
disable_mlock = true
api_addr = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"

listener "tcp" {
  address         = "127.0.0.1:8200"
  cluster_address = "127.0.0.1:8201"
  tls_disable     = true
}

storage "raft" {
  path    = "/openbao/file"
  node_id = "registry-openfn-pilot-045"
}
