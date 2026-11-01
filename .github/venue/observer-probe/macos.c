#include <EndpointSecurity/EndpointSecurity.h>
#include <stdio.h>
int main(void) {
  es_client_t *client = NULL;
  es_new_client_result_t result = es_new_client(&client, ^(es_client_t *c, const es_message_t *m) { (void)c; (void)m; });
  int cleanup = -1;
  int created = result == ES_NEW_CLIENT_RESULT_SUCCESS;
  int cleanup_ok = -1;
  if (created) { es_return_t r = es_delete_client(client); cleanup = (int)r; cleanup_ok = r == ES_RETURN_SUCCESS; }
  printf("{\"source\":\"endpoint-security\",\"new_client_result\":%d,\"delete_client_result\":%d,\"created\":%d,\"cleanup_ok\":%d,\"not_entitled\":%d,\"not_permitted\":%d,\"not_privileged\":%d}\n", (int)result, cleanup, created, cleanup_ok, (int)ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED, (int)ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED, (int)ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED);
  return 0;
}
