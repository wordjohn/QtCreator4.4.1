#include <stdio.h>

#if defined(_WIN32) || defined(WIN32)
#   define EXPORT __declspec(dllexport)
#else
#   define EXPORT __attribute__((visibility("default")))
#endif

EXPORT void dynamic2_hello()
{
    puts("dynamic2 says hello!");
}
