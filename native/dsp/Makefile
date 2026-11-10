CC     ?= cc
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -fPIC

lib: libts6dsp.a
libts6dsp.a: ts6dsp.c ts6dsp.h
	$(CC) $(CFLAGS) -c ts6dsp.c -o ts6dsp.o
	$(AR) rcs $@ ts6dsp.o
test_ts6dsp: test_ts6dsp.c libts6dsp.a
	$(CC) $(CFLAGS) test_ts6dsp.c libts6dsp.a -lm -o $@
wavproc: wavproc.c libts6dsp.a
	$(CC) $(CFLAGS) wavproc.c libts6dsp.a -lm -o $@
test: test_ts6dsp
	./test_ts6dsp
clean:
	rm -f *.o *.a test_ts6dsp wavproc
.PHONY: lib test wavproc clean
