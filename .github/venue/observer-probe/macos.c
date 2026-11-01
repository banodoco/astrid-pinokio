#include <EndpointSecurity/EndpointSecurity.h>
#include <stdio.h>
int main(void) {
  es_client_t *client = NULL;
  es_new_client_result_t result = es_new_client(&client, ^(es_client_t *c, const es_message_t *m) { (void)c; (void)m; });
  int cleanup = -1;
  if (result == ES_NEW_CLIENT_RESULT_SUCCESS) cleanup = (int)es_delete_client(client);
  printf("{\"source\":\"endpoint-security\",\"new_client_result\":%d,\"delete_client_result\":%d}\n", (int)result, cleanup);
  return 0;
}
