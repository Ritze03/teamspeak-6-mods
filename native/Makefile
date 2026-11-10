CC     ?= cc
CFLAGS ?= -O2
CFLAGS += -std=gnu11 -Wall -Wextra -fPIC -fvisibility=hidden

libts6mod.so: ts6mod.c ts6hook.c ts6hook.h dsp/libts6dsp.a dsp/ts6dsp.h
	$(CC) $(CFLAGS) -shared ts6mod.c ts6hook.c dsp/libts6dsp.a -Wl,--exclude-libs,ALL -lm -ldl -lpthread -o $@
dsp/libts6dsp.a: dsp/ts6dsp.c dsp/ts6dsp.h
	$(MAKE) -C dsp lib
clean:
	rm -f libts6mod.so
	$(MAKE) -C dsp clean
.PHONY: clean
