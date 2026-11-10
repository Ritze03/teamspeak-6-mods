CC     ?= cc
CFLAGS ?= -O2
# OUT: output file; install.sh builds to a temp name (never overwrite a library a running client has mapped)
OUT ?= libts6mod.so
CFLAGS += -std=gnu11 -Wall -Wextra -fPIC -fvisibility=hidden

$(OUT): ts6mod.c ts6hook.c ts6hook.h dsp/libts6dsp.a dsp/ts6dsp.h
	$(CC) $(CFLAGS) -shared ts6mod.c ts6hook.c dsp/libts6dsp.a -Wl,--exclude-libs,ALL -lm -ldl -lpthread -o $@
dsp/libts6dsp.a: dsp/ts6dsp.c dsp/ts6dsp.h
	$(MAKE) -C dsp lib
clean:
	rm -f libts6mod.so
	$(MAKE) -C dsp clean
.PHONY: clean
