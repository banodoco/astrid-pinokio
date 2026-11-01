// Diagnostic Endpoint Security consumer. No paths, arguments, environment or
// credentials are recorded. A signed, entitled deployment is an upstream input.
#include <EndpointSecurity/EndpointSecurity.h>
#include <bsm/libbsm.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_EVENTS 4096
struct event { uint64_t seq, time; int type, pid, pidversion, subject_pid, subject_version; unsigned version; };
static struct event events[MAX_EVENTS];
static size_t count;
static int overflow;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static dispatch_semaphore_t barrier;
typedef es_return_t (*sync_fn)(es_client_t *, void (^)(void));

int main(void) {
  es_client_t *client = NULL;
  es_new_client_result_t created = es_new_client(&client, ^(es_client_t *c, const es_message_t *m) {
    (void)c;
    pthread_mutex_lock(&lock);
    if (count == MAX_EVENTS) { overflow = 1; pthread_mutex_unlock(&lock); return; }
    const es_process_t *subject = m->process;
    if (m->event_type == ES_EVENT_TYPE_NOTIFY_FORK) subject = m->event.fork.child;
    if (m->event_type == ES_EVENT_TYPE_NOTIFY_EXEC) subject = m->event.exec.target;
    struct event *e = &events[count++];
    e->version = m->version;
    e->seq = m->version > 4 ? m->global_seq_num : 0;
    e->time = m->mach_time;
    e->type = m->event_type == ES_EVENT_TYPE_NOTIFY_FORK ? 1 : m->event_type == ES_EVENT_TYPE_NOTIFY_EXEC ? 2 : m->event_type == ES_EVENT_TYPE_NOTIFY_EXIT ? 3 : 0;
    e->pid = audit_token_to_pid(m->process->audit_token);
    e->pidversion = audit_token_to_pidversion(m->process->audit_token);
    e->subject_pid = audit_token_to_pid(subject->audit_token);
    e->subject_version = audit_token_to_pidversion(subject->audit_token);
    pthread_mutex_unlock(&lock);
  });
  if (created != ES_NEW_CLIENT_RESULT_SUCCESS) {
    printf("{\"type\":\"open-failed\",\"code\":%d}\n", (int)created);
    return 1;
  }
  const es_event_type_t types[] = { ES_EVENT_TYPE_NOTIFY_FORK, ES_EVENT_TYPE_NOTIFY_EXEC, ES_EVENT_TYPE_NOTIFY_EXIT };
  es_return_t subscribed = es_subscribe(client, types, 3);
  if (subscribed != ES_RETURN_SUCCESS) {
    es_return_t deleted = es_delete_client(client);
    printf("{\"type\":\"subscribe-failed\",\"code\":%d,\"cleanup\":%d}\n", (int)subscribed, (int)deleted);
    return 1;
  }
  puts("{\"type\":\"ready\"}"); fflush(stdout);
  // A single byte requests closure. EOF is also cleanup, but is not a valid stop.
  int stop = getchar();
  es_return_t unsub = es_unsubscribe_all(client);
  int synced = 0;
  sync_fn sync_client = (sync_fn)dlsym(RTLD_DEFAULT, "es_sync_client");
  barrier = dispatch_semaphore_create(0);
  if (unsub == ES_RETURN_SUCCESS && sync_client && barrier && sync_client(client, ^{ dispatch_semaphore_signal(barrier); }) == ES_RETURN_SUCCESS) {
    synced = dispatch_semaphore_wait(barrier, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
  }
  es_return_t deleted = es_delete_client(client);
  pthread_mutex_lock(&lock);
  for (size_t i = 0; i < count; i++) {
    struct event *e = &events[i];
    printf("{\"type\":\"event\",\"version\":%u,\"sequence\":\"%" PRIu64 "\",\"mach_time\":\"%" PRIu64 "\",\"event\":%d,\"pid\":%d,\"pidversion\":%d,\"subject_pid\":%d,\"subject_version\":%d}\n", e->version, e->seq, e->time, e->type, e->pid, e->pidversion, e->subject_pid, e->subject_version);
  }
  printf("{\"type\":\"terminal\",\"stop\":%d,\"unsubscribe\":%d,\"barrier\":%d,\"cleanup\":%d,\"overflow\":%d}\n", stop == 'Q', (int)unsub, synced, (int)deleted, overflow);
  pthread_mutex_unlock(&lock);
  return 0;
}
