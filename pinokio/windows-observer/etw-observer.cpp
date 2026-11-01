// Windows-only diagnostic ETW consumer. Build with the Windows SDK:
// cl /nologo /EHsc /W4 /O2 etw-observer.cpp /link advapi32.lib
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <evntrace.h>
#include <evntcons.h>
#include <cstdio>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
static const GUID provider = {0x22fb2cd6,0x0e7b,0x422b,{0xa0,0xc7,0x2f,0xad,0x1f,0xd0,0xe7,0x16}};
struct Event { unsigned pid, id, opcode, version; };
static std::vector<Event> events;
static unsigned overflowCount = 0, bufferLoss = 0;
static TRACEHANDLE consumer = INVALID_PROCESSTRACE_HANDLE;
static ULONG processStatus = ERROR_GEN_FAILURE;
static HANDLE stopSignal;
static void WINAPI onEvent(PEVENT_RECORD record) {
  if (!IsEqualGUID(record->EventHeader.ProviderId, provider)) return;
  if (events.size() >= 1024) { if (overflowCount != 0xffffffffU) ++overflowCount; return; }
  const EVENT_HEADER& h = record->EventHeader;
  events.push_back({h.ProcessId, h.EventDescriptor.Id, h.EventDescriptor.Opcode, h.EventDescriptor.Version});
}
static ULONG WINAPI onBuffer(PEVENT_TRACE_LOGFILEW log) {
  if (log->LogfileHeader.BuffersLost > bufferLoss) bufferLoss = log->LogfileHeader.BuffersLost;
  return TRUE;
}
static DWORD WINAPI processEvents(void*) { processStatus = ProcessTrace(&consumer, 1, nullptr, nullptr); return 0; }
static DWORD WINAPI readStop(void*) { char c; DWORD n; ReadFile(GetStdHandle(STD_INPUT_HANDLE), &c, 1, &n, nullptr); SetEvent(stopSignal); return 0; }
int wmain() {
  events.reserve(1024);
  GUID id; if (CoCreateGuid(&id) != S_OK) return 2;
  wchar_t name[80]; swprintf_s(name, L"r25-win-%08lx-%04x-%04x-%02x%02x%02x%02x%02x%02x%02x%02x", id.Data1, id.Data2, id.Data3, id.Data4[0], id.Data4[1], id.Data4[2], id.Data4[3], id.Data4[4], id.Data4[5], id.Data4[6], id.Data4[7]);
  const size_t size = sizeof(EVENT_TRACE_PROPERTIES) + sizeof(name);
  std::vector<unsigned char> memory(size, 0);
  auto p = reinterpret_cast<EVENT_TRACE_PROPERTIES*>(memory.data());
  p->Wnode.BufferSize = static_cast<ULONG>(size); p->Wnode.Flags = WNODE_FLAG_TRACED_GUID; p->Wnode.ClientContext = 1;
  p->LogFileMode = EVENT_TRACE_REAL_TIME_MODE; p->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES); p->FlushTimer = 1;
  TRACEHANDLE session = 0; ULONG start = StartTraceW(&session, name, p), enable = ERROR_GEN_FAILURE, stop = ERROR_GEN_FAILURE, close = ERROR_GEN_FAILURE;
  bool opened = false, processed = false, timedOut = false;
  HANDLE worker = nullptr;
  EVENT_TRACE_LOGFILEW log = {};
  if (start == ERROR_SUCCESS) {
    GUID mutableProvider = provider;
    enable = EnableTraceEx2(session, &mutableProvider, EVENT_CONTROL_CODE_ENABLE_PROVIDER, TRACE_LEVEL_VERBOSE, 0x10, 0, 5000, nullptr);
    if (enable == ERROR_SUCCESS) {
      log.LoggerName = name; log.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
      log.EventRecordCallback = onEvent; log.BufferCallback = onBuffer;
      consumer = OpenTraceW(&log);
      if (consumer != INVALID_PROCESSTRACE_HANDLE) {
        opened = true; worker = CreateThread(nullptr, 0, processEvents, nullptr, 0, nullptr);
        stopSignal = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (worker && stopSignal) {
          HANDLE reader = CreateThread(nullptr, 0, readStop, nullptr, 0, nullptr);
          if (reader) {
            std::printf("{\"ready\":true}\n"); std::fflush(stdout);
            timedOut = WaitForSingleObject(stopSignal, 30000) != WAIT_OBJECT_0;
            CloseHandle(reader);
          }
        }
      }
    }
    stop = ControlTraceW(session, name, p, EVENT_TRACE_CONTROL_STOP);
    if (worker) processed = WaitForSingleObject(worker, 10000) == WAIT_OBJECT_0;
    if (opened) close = CloseTrace(consumer);
    if (worker && !processed) processed = WaitForSingleObject(worker, 3000) == WAIT_OBJECT_0;
  }
  // A running callback means its data cannot safely be read, and no closure is asserted.
  if (worker && !processed) { std::printf("{\"fatal\":\"consumer-not-terminated\"}\n"); std::fflush(stdout); ExitProcess(3); }
  if (worker) CloseHandle(worker);
  // The reader can still be blocked on stdin. Process exit owns its lifetime.
  std::printf("{\"start\":%lu,\"enable\":%lu,\"opened\":%s,\"process\":%lu,\"stop\":%lu,\"close\":%lu,\"timed_out\":%s,\"events_lost\":%lu,\"buffers_lost\":%lu,\"realtime_buffers_lost\":%lu,\"consumer_buffers_lost\":%u,\"overflow\":%u,\"terminal\":%s,\"events\":[", start, enable, opened?"true":"false", processStatus, stop, close, timedOut?"true":"false", p->EventsLost, p->LogBuffersLost, p->RealTimeBuffersLost, bufferLoss, overflowCount, processed?"true":"false");
  for (size_t i = 0; i < events.size(); ++i) { const auto &e = events[i]; std::printf("%s{\"sequence\":%zu,\"emitter_pid\":%u,\"event_id\":%u,\"opcode\":%u,\"version\":%u}", i ? "," : "", i+1, e.pid, e.id, e.opcode, e.version); }
  std::printf("]}\n"); std::fflush(stdout);
  return 0;
}
