#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long pid_value = strtol(argv[1], &end, 10);
  if (!end || end == argv[1] || *end || pid_value <= 0 || pid_value > INT_MAX || (long)(pid_t)pid_value != pid_value) return 2;
  pid_t pid = (pid_t)pid_value;
  struct rusage_info_v6 usage = {0};
  errno = 0;
  int result = proc_pid_rusage(pid, RUSAGE_INFO_V6, (rusage_info_t *)&usage);
  if (result != 0) {
    printf("{\"pid\":%d,\"errno\":%d}\n", pid, errno);
    return 1;
  }
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != 0) return 1;
  /* proc_pid_rusage CPU counters are Mach absolute ticks, not nanoseconds. */
  uint64_t user_ns = (uint64_t)((long double)usage.ri_user_time * timebase.numer / timebase.denom);
  uint64_t system_ns = (uint64_t)((long double)usage.ri_system_time * timebase.numer / timebase.denom);
  printf("{\"pid\":%d,\"physicalFootprint\":%" PRIu64 ",\"residentSizeRSS\":%" PRIu64 ",\"lifetimeMaxPhysicalFootprint\":%" PRIu64 ",\"userTimeNs\":%" PRIu64 ",\"systemTimeNs\":%" PRIu64 ",\"startAbstime\":%" PRIu64 ",\"energyNj\":%" PRIu64 ",\"userTimeMach\":%" PRIu64 ",\"systemTimeMach\":%" PRIu64 ",\"timebaseNumer\":%u,\"timebaseDenom\":%u}\n",
         pid, usage.ri_phys_footprint, usage.ri_resident_size,
         usage.ri_lifetime_max_phys_footprint, user_ns, system_ns,
         usage.ri_proc_start_abstime, usage.ri_energy_nj,
         usage.ri_user_time, usage.ri_system_time, timebase.numer, timebase.denom);
  return 0;
}
