$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TraceProbe {
 [StructLayout(LayoutKind.Sequential)] struct WNODE { public uint BufferSize, ProviderId; public ulong HistoricalContext; public long TimeStamp; public Guid Guid; public uint ClientContext, Flags; }
 [StructLayout(LayoutKind.Sequential)] struct PROPS { public WNODE Wnode; public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags; public int AgeLimit; public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost; public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset; }
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint StartTraceW(out ulong handle, string name, IntPtr properties);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr properties, uint code);
 [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint control, byte level, ulong any, ulong all, uint timeout, IntPtr parameters);
 public static string Run() {
  string name = "r25-probe-" + Guid.NewGuid().ToString("N");
  int size = Marshal.SizeOf(typeof(PROPS)) + (name.Length + 1) * 2;
  IntPtr ptr = Marshal.AllocHGlobal(size); ulong handle = 0; uint start = 0, enable = UInt32.MaxValue, stop = UInt32.MaxValue;
  try {
   for (int i=0; i<size; i++) Marshal.WriteByte(ptr, i, 0);
   PROPS p = new PROPS(); p.Wnode.BufferSize = (uint)size; p.Wnode.Flags = 0x20000; p.Wnode.ClientContext = 1; p.LogFileMode = 0x100; p.LoggerNameOffset = (uint)Marshal.SizeOf(typeof(PROPS));
   Marshal.StructureToPtr(p, ptr, false);
   start = StartTraceW(out handle, name, ptr);
   if (start == 0) {
    try { Guid provider = new Guid("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716"); enable = EnableTraceEx2(handle, ref provider, 1, 5, 0x10, 0, 5000, IntPtr.Zero); }
    finally { stop = ControlTraceW(handle, name, ptr, 1); }
   }
  } finally { Marshal.FreeHGlobal(ptr); }
  return String.Format("{{\"source\":\"etw-kernel-process\",\"start_status\":{0},\"enable_status\":{1},\"stop_status\":{2}}}", start, enable, stop);
 }
}
'@
[TraceProbe]::Run()
